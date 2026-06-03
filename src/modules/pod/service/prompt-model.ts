import { Inject, Provide } from '@midwayjs/core';
import axios from 'axios';
import { PodSettingService, PodModuleSettings } from './setting';

export interface PromptModelItem {
  subTheme: string;
  prompt: string;
  seoFileName: string;
  seoTitle?: string;
  tags?: string[];
}

type PromptProtocol = 'openai-chat' | 'anthropic-messages';

/**
 * 提示词模型生成服务
 *
 * 负责把批次主题交给外部大模型，拿回每张图的差异化提示词。
 * 目前支持 OpenAI Chat Completions 和 Anthropic Messages 两种中转站协议。
 */
@Provide()
export class PodPromptModelService {
  @Inject()
  podSettingService: PodSettingService;

  async generate(topic: string, count: number): Promise<PromptModelItem[]> {
    const settings = await this.podSettingService.getSettings();
    const promptConfig = settings.prompt;
    const protocol = this.normalizeProtocol(promptConfig.protocol);

    const content =
      protocol === 'anthropic-messages'
        ? await this.requestAnthropicMessages(settings, topic, count)
        : await this.requestOpenaiChat(settings, topic, count);

    return this.parseItems(content, count);
  }

  getPromptSource(settings: PodModuleSettings) {
    // 来源只记录 provider，便于后台列表查看，也避免超过数据库字段长度。
    return String(settings.prompt.provider || 'prompt-model').slice(0, 30);
  }

  private async requestOpenaiChat(
    settings: PodModuleSettings,
    topic: string,
    count: number
  ) {
    const promptConfig = settings.prompt;
    const res = await axios.post(
      promptConfig.endpoint || 'https://api.deepseek.com/chat/completions',
      {
        model: promptConfig.model || 'deepseek-v4-pro',
        messages: [
          {
            role: 'system',
            content: promptConfig.systemPrompt,
          },
          {
            role: 'user',
            content: this.buildUserPrompt(topic, count),
          },
        ],
        temperature: promptConfig.temperature,
        stream: false,
      },
      {
        timeout: 120000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${promptConfig.apiKey}`,
        },
      }
    );

    const content = res.data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('提示词模型未返回内容');
    }
    return content;
  }

  private async requestAnthropicMessages(
    settings: PodModuleSettings,
    topic: string,
    count: number
  ) {
    const promptConfig = settings.prompt;
    const res = await axios.post(
      promptConfig.endpoint || 'https://api.avemujica.moe/v1/messages',
      {
        model: promptConfig.model || 'claude-opus-4-8',
        max_tokens: promptConfig.maxTokens || 8192,
        system: promptConfig.systemPrompt,
        messages: [
          {
            role: 'user',
            content: this.buildUserPrompt(topic, count),
          },
        ],
      },
      {
        timeout: 120000,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': promptConfig.apiKey,
          'anthropic-version': '2023-06-01',
        },
      }
    );

    const content = this.readAnthropicText(res.data?.content);
    if (!content) {
      throw new Error('Claude 提示词模型未返回内容');
    }
    return content;
  }

  private buildUserPrompt(topic: string, count: number) {
    // 这段是系统输出格式约束，不建议放到后台让业务配置，避免模型返回结构失控。
    return `Create ${count} different image generation prompts for this POD T-shirt direction: "${topic}".

Return ONLY valid JSON, no markdown fences, no explanation.
JSON shape:
{
      "items": [
    {
      "subTheme": "short English subtheme",
      "prompt": "English image prompt describing only the unique visual concept, subject, style, mood, composition details, and key objects for this one print.",
      "seoFileName": "lowercase-kebab-case-5-to-10-keywords",
      "seoTitle": "SEO friendly English title",
      "tags": ["tag1", "tag2", "tag3"]
    }
  ]
}

Rules:
- items length must be exactly ${count}.
- Each item must be visually distinct.
- Keep prompts safe and original.
- Do not mention Disney, Marvel, Pokemon, celebrities, brands, sports teams, or trademarked terms.
- Do not repeat shared POD production requirements such as transparent background, no mockup, no shirt, no model, no watermark, no brand logo, 1:1, or resolution. Those are applied by module settings.`;
  }

  private parseItems(content: string, count: number) {
    // 严格校验数量，防止前端创建 10 张但实际只落库 8 条。
    const jsonText = this.extractJson(content);
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(`提示词模型 JSON 解析失败：${err.message}`);
    }

    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    if (items.length !== count) {
      throw new Error(`提示词模型返回 ${items.length} 条，期望 ${count} 条`);
    }

    return items.map((item, index) => ({
      subTheme: String(item.subTheme || `prompt ${index + 1}`).slice(0, 120),
      prompt: String(item.prompt || '').trim(),
      seoFileName: this.slugify(item.seoFileName || item.seoTitle || item.subTheme),
      seoTitle: item.seoTitle ? String(item.seoTitle).slice(0, 180) : '',
      tags: Array.isArray(item.tags) ? item.tags.map(tag => String(tag)) : [],
    }));
  }

  private extractJson(content: string) {
    // 兼容模型偶尔包一层 markdown fence 的情况，但最终仍只接受 JSON 对象。
    const trimmed = content.trim().replace(/^```json\s*|\s*```$/g, '');
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end < 0 || end <= start) {
      throw new Error('提示词模型响应中没有 JSON 对象');
    }
    return trimmed.slice(start, end + 1);
  }

  private slugify(value: string) {
    // SEO 文件名只用于去重和历史兼容，最终图片文件名仍按标题保存。
    return String(value || 'pod-tshirt-print')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .filter(Boolean)
      .slice(0, 10)
      .join('-');
  }

  private normalizeProtocol(value: string): PromptProtocol {
    return value === 'anthropic-messages' ? 'anthropic-messages' : 'openai-chat';
  }

  private readAnthropicText(content: any) {
    if (typeof content === 'string') {
      return content;
    }
    if (!Array.isArray(content)) {
      return '';
    }
    return content
      .map(item => {
        if (typeof item === 'string') {
          return item;
        }
        return item?.type === 'text' || item?.text ? String(item.text || '') : '';
      })
      .filter(Boolean)
      .join('\n');
  }
}
