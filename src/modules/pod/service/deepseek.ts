import { Inject, Provide } from '@midwayjs/core';
import axios from 'axios';
import { PodSettingService } from './setting';

export interface DeepseekPromptItem {
  subTheme: string;
  prompt: string;
  seoFileName: string;
  seoTitle?: string;
  tags?: string[];
}

/**
 * DeepSeek 提示词生成
 */
@Provide()
export class PodDeepseekService {
  @Inject()
  podSettingService: PodSettingService;

  async generate(topic: string, count: number): Promise<DeepseekPromptItem[]> {
    // DeepSeek 只负责生成每张图的差异化 Prompt，公共 POD 约束在生图阶段统一追加。
    const settings = await this.podSettingService.getSettings();
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
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
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
      throw new Error('DeepSeek did not return prompt content');
    }

    return this.parseItems(content, count);
  }

  private buildUserPrompt(topic: string, count: number) {
    // 强制 DeepSeek 返回 JSON，避免后端需要解析自然语言说明。
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
      throw new Error(`DeepSeek JSON parse failed: ${err.message}`);
    }

    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    if (items.length !== count) {
      throw new Error(`DeepSeek returned ${items.length} prompts, expected ${count}`);
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
      throw new Error('DeepSeek response does not contain a JSON object');
    }
    return trimmed.slice(start, end + 1);
  }

  private slugify(value: string) {
    // SEO 文件名只保留英文、数字和连字符，便于落盘和 URL 访问。
    return String(value || 'pod-tshirt-print')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .filter(Boolean)
      .slice(0, 10)
      .join('-');
  }
}
