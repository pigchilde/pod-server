import { Config, Provide } from '@midwayjs/core';
import { CoolCommException } from '@cool-midway/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { PodModuleSettingEntity } from '../entity/setting';

export interface PodModuleSettings {
  generation: {
    outputDir: string;
    provider: string;
    timeoutMs: number;
    endpoint: string;
    apiKey: string;
    model: string;
    size: string;
    outputSize: string;
  };
  prompt: {
    provider: string;
    endpoint: string;
    apiKey: string;
    model: string;
    systemPrompt: string;
  };
  cutout: {
    enabled: boolean;
    endpoint: string;
    model: string;
    timeoutMs: number;
  };
  unifiedPrompt: string;
}

export const DEFAULT_POD_SYSTEM_PROMPT =
  'You generate safe, original POD T-shirt print image prompts. Return strict JSON only. Avoid copyrighted characters, brands, celebrities, sports teams, trademarks, and marketplace policy risks.';

export const DEFAULT_POD_UNIFIED_PROMPT =
  'Square 1:1 composition, 2048x2048 output, centered T-shirt print artwork, transparent background, high contrast, clean silhouette, screen print friendly, POD ready, no mockup, no shirt, no model, no watermark, no brand logo.';

/**
 * POD模块设置
 */
@Provide()
export class PodSettingService {
  @InjectEntityModel(PodModuleSettingEntity)
  settingEntity: Repository<PodModuleSettingEntity>;

  @Config('module.pod.generation')
  generationConfig;

  @Config('module.pod.prompt')
  promptConfig;

  @Config('module.pod.cutout')
  cutoutConfig;

  async getSettings(): Promise<PodModuleSettings> {
    // 数据库没有保存过设置时，回退到模块 config.ts 里的默认值，保证初始化即可使用。
    const row = await this.settingEntity.findOneBy({ keyName: 'default' });
    if (!row?.data) {
      return this.defaultSettings();
    }

    try {
      return this.mergeSettings(JSON.parse(row.data));
    } catch (err) {
      throw new CoolCommException(`POD模块设置解析失败：${err.message}`);
    }
  }

  async saveSettings(params: any) {
    // 只保留服务端认可的字段，避免前端额外参数直接写入运行配置。
    const settings = this.mergeSettings(params);
    const row = await this.settingEntity.findOneBy({ keyName: 'default' });
    const data = JSON.stringify(settings);

    if (row) {
      await this.settingEntity.update(row.id, { data });
    } else {
      await this.settingEntity.save({
        keyName: 'default',
        data,
      });
    }

    return settings;
  }

  appendUnifiedPrompt(prompt: string, settings: PodModuleSettings) {
    // 生图前先放公共约束，再接每条图的差异化内容，提升模型对全局要求的遵循度。
    const unifiedPrompt = String(settings.unifiedPrompt || '').trim();
    if (!unifiedPrompt) {
      return prompt;
    }
    return `${unifiedPrompt}\n\nImage-specific prompt:\n${prompt.trim()}`;
  }

  private mergeSettings(value: any): PodModuleSettings {
    // 合并默认值并做轻量格式清洗，防止空字符串把关键配置覆盖掉。
    const defaults = this.defaultSettings();
    return {
      generation: {
        outputDir: this.str(value?.generation?.outputDir, defaults.generation.outputDir),
        provider: this.str(value?.generation?.provider, defaults.generation.provider),
        timeoutMs: this.num(value?.generation?.timeoutMs, defaults.generation.timeoutMs),
        endpoint: this.str(value?.generation?.endpoint, defaults.generation.endpoint),
        apiKey: this.str(value?.generation?.apiKey, defaults.generation.apiKey),
        model: this.str(value?.generation?.model, defaults.generation.model),
        size: this.normalizeSize(value?.generation?.size || defaults.generation.size),
        outputSize: this.normalizeSize(
          value?.generation?.outputSize || defaults.generation.outputSize
        ),
      },
      prompt: {
        provider: this.str(value?.prompt?.provider, defaults.prompt.provider),
        endpoint: this.str(value?.prompt?.endpoint, defaults.prompt.endpoint),
        apiKey: this.str(value?.prompt?.apiKey, defaults.prompt.apiKey),
        model: this.str(value?.prompt?.model, defaults.prompt.model),
        systemPrompt: this.str(
          value?.prompt?.systemPrompt,
          defaults.prompt.systemPrompt
        ),
      },
      cutout: {
        enabled:
          typeof value?.cutout?.enabled === 'boolean'
            ? value.cutout.enabled
            : defaults.cutout.enabled,
        endpoint: this.str(value?.cutout?.endpoint, defaults.cutout.endpoint),
        model: this.str(value?.cutout?.model, defaults.cutout.model),
        timeoutMs: this.num(value?.cutout?.timeoutMs, defaults.cutout.timeoutMs),
      },
      unifiedPrompt: this.str(value?.unifiedPrompt, defaults.unifiedPrompt),
    };
  }

  private defaultSettings(): PodModuleSettings {
    // 默认值仍来自代码配置，后台设置只是在运行期覆盖这些默认值。
    return {
      generation: {
        outputDir: this.generationConfig?.outputDir || '../generated/temu-tshirt',
        provider: this.generationConfig?.provider || 'rightcodes',
        timeoutMs: Number(this.generationConfig?.timeoutMs || 180000),
        endpoint:
          this.generationConfig?.endpoint ||
          'https://www.right.codes/draw/v1/images/generations',
        apiKey: this.generationConfig?.apiKey || '',
        model: this.generationConfig?.model || 'gpt-image-2',
        size: this.generationConfig?.size || '1024x1024',
        outputSize: this.generationConfig?.outputSize || '2048x2048',
      },
      prompt: {
        provider: this.promptConfig?.provider || 'deepseek',
        endpoint:
          this.promptConfig?.endpoint ||
          'https://api.deepseek.com/chat/completions',
        apiKey: this.promptConfig?.apiKey || '',
        model: this.promptConfig?.model || 'deepseek-v4-pro',
        systemPrompt: this.promptConfig?.systemPrompt || DEFAULT_POD_SYSTEM_PROMPT,
      },
      cutout: {
        enabled: this.cutoutConfig?.enabled ?? true,
        endpoint: this.cutoutConfig?.endpoint || 'http://127.0.0.1:8000',
        model: this.cutoutConfig?.model || 'birefnet.safetensors',
        timeoutMs: Number(this.cutoutConfig?.timeoutMs || 180000),
      },
      unifiedPrompt: DEFAULT_POD_UNIFIED_PROMPT,
    };
  }

  private str(value: any, fallback: string) {
    const text = String(value ?? '').trim();
    return text || fallback;
  }

  private num(value: any, fallback: number) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : fallback;
  }

  private normalizeSize(value: any) {
    // 当前图片接口使用 2048x2048 这类字符串表达尺寸。
    const size = String(value || '').trim();
    if (/^\d+x\d+$/.test(size)) {
      return size;
    }
    return '2048x2048';
  }
}
