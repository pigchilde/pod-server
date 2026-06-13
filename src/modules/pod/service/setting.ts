import { Config, Inject, Provide } from '@midwayjs/core';
import { CoolCommException } from '@cool-midway/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { PodModuleSettingEntity } from '../entity/setting';
import { PodProviderConfigService } from './provider';
import {
  DEFAULT_POD_SYSTEM_PROMPT,
  DEFAULT_POD_UNIFIED_PROMPT,
} from './constants';

export { DEFAULT_POD_SYSTEM_PROMPT, DEFAULT_POD_UNIFIED_PROMPT };

export interface PodModuleSettings {
  generation: {
    outputDir: string;
    providerId: number;
    provider: string;
    providerName: string;
    protocol: string;
    concurrency: number;
    timeoutMs: number;
    endpoint: string;
    apiKey: string;
    model: string;
    size: string;
    outputSize: string;
  };
  prompt: {
    providerId: number;
    provider: string;
    providerName: string;
    protocol: string;
    endpoint: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    temperature: number;
    maxTokens: number;
    systemPrompt: string;
  };
  cutout: {
    enabled: boolean;
    endpoint: string;
    model: string;
    timeoutMs: number;
    blackThreshold: number;
    processRes: number;
    maskBlur: number;
    subjectMaskOffset: number;
  };
  unifiedPrompt: string;
}

interface PersistedPodSettings {
  generation: {
    outputDir: string;
    providerId: number;
    timeoutMs: number;
    size: string;
    outputSize: string;
  };
  prompt: {
    providerId: number;
    timeoutMs: number;
    temperature: number;
    maxTokens: number;
    systemPrompt: string;
  };
  cutout: PodModuleSettings['cutout'];
  unifiedPrompt: string;
}

/**
 * POD模块设置
 */
@Provide()
export class PodSettingService {
  @InjectEntityModel(PodModuleSettingEntity)
  settingEntity: Repository<PodModuleSettingEntity>;

  @Inject()
  podProviderConfigService: PodProviderConfigService;

  @Config('module.pod.generation')
  generationConfig;

  @Config('module.pod.prompt')
  promptConfig;

  @Config('module.pod.cutout')
  cutoutConfig;

  async getSettings(): Promise<PodModuleSettings> {
    const row = await this.settingEntity.findOneBy({ keyName: 'default' });
    const raw = await this.readSettingsData(row?.data);
    const settings = await this.mergeSettings(raw);

    // 旧版设置里没有 providerId 时，自动迁移成“选择供应商”的新结构。
    if (row?.data && this.needsMigration(raw)) {
      await this.settingEntity.update(row.id, {
        data: JSON.stringify(this.toPersistedSettings(settings)),
      });
    }

    return settings;
  }

  async saveSettings(params: any) {
    const current = await this.getSettings();
    const imageProviderId =
      Number(params?.generation?.providerId) || current.generation.providerId;
    const promptProviderId =
      Number(params?.prompt?.providerId) || current.prompt.providerId;

    await this.podProviderConfigService.requireEnabled(imageProviderId, 'image');
    await this.podProviderConfigService.requireEnabled(promptProviderId, 'prompt');

    const settings: PersistedPodSettings = {
      generation: {
        outputDir: this.str(
          params?.generation?.outputDir,
          current.generation.outputDir
        ),
        providerId: imageProviderId,
        timeoutMs: this.numInRange(
          params?.generation?.timeoutMs,
          current.generation.timeoutMs,
          30000,
          600000
        ),
        size: this.normalizeSize(params?.generation?.size, current.generation.size),
        outputSize: this.normalizeSize(
          params?.generation?.outputSize,
          current.generation.outputSize
        ),
      },
      prompt: {
        providerId: promptProviderId,
        timeoutMs: this.numInRange(
          params?.prompt?.timeoutMs,
          current.prompt.timeoutMs,
          30000,
          600000
        ),
        temperature: this.numFloatInRange(
          params?.prompt?.temperature,
          current.prompt.temperature,
          0,
          2
        ),
        maxTokens: this.numInRange(
          params?.prompt?.maxTokens,
          current.prompt.maxTokens,
          1024,
          64000
        ),
        systemPrompt: this.str(params?.prompt?.systemPrompt, current.prompt.systemPrompt),
      },
      cutout: this.normalizeCutout(params?.cutout, current.cutout),
      unifiedPrompt: this.str(params?.unifiedPrompt, current.unifiedPrompt),
    };

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

    return this.getSettings();
  }

  appendUnifiedPrompt(prompt: string, settings: PodModuleSettings) {
    const unifiedPrompt = String(settings.unifiedPrompt || '').trim();
    if (!unifiedPrompt) {
      return prompt;
    }
    return `${unifiedPrompt}\n\nImage-specific prompt:\n${prompt.trim()}`;
  }

  private async readSettingsData(data?: string) {
    if (!data) {
      return this.defaultRawSettings();
    }

    try {
      return JSON.parse(data);
    } catch (err) {
      throw new CoolCommException(`POD模块设置解析失败：${err.message}`);
    }
  }

  private async mergeSettings(value: any): Promise<PodModuleSettings> {
    const defaults = this.defaultRawSettings();
    const imageProvider = await this.podProviderConfigService.resolveForSettings(
      'image',
      value?.generation?.providerId,
      {
        ...defaults.generation,
        ...(value?.generation || {}),
      }
    );
    const promptProvider = await this.podProviderConfigService.resolveForSettings(
      'prompt',
      value?.prompt?.providerId,
      {
        ...defaults.prompt,
        ...(value?.prompt || {}),
      }
    );

    return {
      generation: {
        outputDir: this.str(value?.generation?.outputDir, defaults.generation.outputDir),
        providerId: imageProvider.id,
        provider: imageProvider.code,
        providerName: imageProvider.name,
        protocol: imageProvider.protocol,
        concurrency: imageProvider.concurrency,
        timeoutMs: this.numInRange(
          value?.generation?.timeoutMs,
          defaults.generation.timeoutMs,
          30000,
          600000
        ),
        endpoint: imageProvider.endpoint,
        apiKey: imageProvider.apiKey,
        model: imageProvider.model,
        size: this.normalizeSize(value?.generation?.size, defaults.generation.size),
        outputSize: this.normalizeSize(
          value?.generation?.outputSize,
          defaults.generation.outputSize
        ),
      },
      prompt: {
        providerId: promptProvider.id,
        provider: promptProvider.code,
        providerName: promptProvider.name,
        protocol: promptProvider.protocol,
        endpoint: promptProvider.endpoint,
        apiKey: promptProvider.apiKey,
        model: promptProvider.model,
        timeoutMs: this.numInRange(
          value?.prompt?.timeoutMs,
          defaults.prompt.timeoutMs,
          30000,
          600000
        ),
        temperature: this.numFloatInRange(
          value?.prompt?.temperature,
          defaults.prompt.temperature,
          0,
          2
        ),
        maxTokens: this.numInRange(
          value?.prompt?.maxTokens,
          defaults.prompt.maxTokens,
          1024,
          64000
        ),
        systemPrompt: this.str(
          value?.prompt?.systemPrompt,
          defaults.prompt.systemPrompt
        ),
      },
      cutout: this.normalizeCutout(value?.cutout, defaults.cutout),
      unifiedPrompt: this.str(value?.unifiedPrompt, defaults.unifiedPrompt),
    };
  }

  private toPersistedSettings(settings: PodModuleSettings): PersistedPodSettings {
    return {
      generation: {
        outputDir: settings.generation.outputDir,
        providerId: settings.generation.providerId,
        timeoutMs: settings.generation.timeoutMs,
        size: settings.generation.size,
        outputSize: settings.generation.outputSize,
      },
      prompt: {
        providerId: settings.prompt.providerId,
        timeoutMs: settings.prompt.timeoutMs,
        temperature: settings.prompt.temperature,
        maxTokens: settings.prompt.maxTokens,
        systemPrompt: settings.prompt.systemPrompt,
      },
      cutout: settings.cutout,
      unifiedPrompt: settings.unifiedPrompt,
    };
  }

  private needsMigration(value: any) {
    return (
      !value?.generation?.providerId ||
      !value?.prompt?.providerId ||
      value?.generation?.endpoint ||
      value?.generation?.apiKey ||
      value?.generation?.model ||
      value?.prompt?.endpoint ||
      value?.prompt?.apiKey ||
      value?.prompt?.model
    );
  }

  private defaultRawSettings() {
    return {
      generation: {
        outputDir: this.generationConfig?.outputDir || '../generated/temu-tshirt',
        provider: this.generationConfig?.provider || 'rightcodes',
        protocol: this.generationConfig?.protocol || 'openai-images',
        concurrency: Number(this.generationConfig?.concurrency || 3),
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
        protocol: this.promptConfig?.protocol || 'openai-chat',
        timeoutMs: Number(this.promptConfig?.timeoutMs || 120000),
        endpoint:
          this.promptConfig?.endpoint ||
          'https://api.deepseek.com/chat/completions',
        apiKey: this.promptConfig?.apiKey || '',
        model: this.promptConfig?.model || 'deepseek-v4-pro',
        temperature: Number(this.promptConfig?.temperature ?? 0.7),
        maxTokens: Number(this.promptConfig?.maxTokens || 8192),
        systemPrompt: this.promptConfig?.systemPrompt || DEFAULT_POD_SYSTEM_PROMPT,
      },
      cutout: {
        enabled: this.cutoutConfig?.enabled ?? true,
        endpoint: this.cutoutConfig?.endpoint || 'http://127.0.0.1:8000',
        model: this.normalizeCutoutModel(this.cutoutConfig?.model, 'RMBG-2.0'),
        timeoutMs: Number(this.cutoutConfig?.timeoutMs || 180000),
        blackThreshold: Number(this.cutoutConfig?.blackThreshold || 34),
        processRes: Number(this.cutoutConfig?.processRes || 1536),
        maskBlur: Number(this.cutoutConfig?.maskBlur ?? 1),
        subjectMaskOffset: Number(this.cutoutConfig?.subjectMaskOffset ?? -1),
      },
      unifiedPrompt: DEFAULT_POD_UNIFIED_PROMPT,
    };
  }

  private normalizeCutout(value: any, defaults: PodModuleSettings['cutout']) {
    return {
      enabled:
        typeof value?.enabled === 'boolean' ? value.enabled : defaults.enabled,
      endpoint: this.str(value?.endpoint, defaults.endpoint),
      model: this.normalizeCutoutModel(value?.model, defaults.model),
      timeoutMs: this.num(value?.timeoutMs, defaults.timeoutMs),
      blackThreshold: this.numInRange(
        value?.blackThreshold,
        defaults.blackThreshold,
        0,
        255
      ),
      processRes: this.numInRange(value?.processRes, defaults.processRes, 256, 2048),
      maskBlur: this.numInRange(value?.maskBlur, defaults.maskBlur, 0, 64),
      subjectMaskOffset: this.numInRange(
        value?.subjectMaskOffset,
        defaults.subjectMaskOffset,
        -64,
        64
      ),
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

  private numInRange(value: any, fallback: number, min: number, max: number) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(num)));
  }

  private numFloatInRange(value: any, fallback: number, min: number, max: number) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, num));
  }

  private normalizeSize(value: any, fallback: string) {
    const size = String(value || '').trim();
    if (/^\d+x\d+$/.test(size)) {
      return size;
    }
    return fallback;
  }

  private normalizeCutoutModel(value: any, fallback: string) {
    const model = this.str(value, fallback);
    if (['RMBG-2.0', 'INSPYRENET', 'BEN', 'BEN2'].includes(model)) {
      return model;
    }
    return 'RMBG-2.0';
  }
}
