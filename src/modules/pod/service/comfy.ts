import { Inject, Provide } from '@midwayjs/core';
import axios from 'axios';
import * as sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { PodModuleSettings, PodSettingService } from './setting';

export interface PodComfyCutoutInput {
  buffer: Buffer;
  fileName: string;
  settings: PodModuleSettings;
  context?: {
    batchId?: number;
    batchNo?: string;
    itemId?: number;
    itemNo?: string;
    fileName?: string;
  };
}

interface ComfyOutputImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

/**
 * ComfyUI 抠图后处理
 */
@Provide()
export class PodComfyService {
  @Inject()
  podSettingService: PodSettingService;

  private cutoutQueue: Promise<any> = Promise.resolve();
  private activeCutoutCount = 0;
  private lastFreeAt = 0;

  async removeBackground(input: PodComfyCutoutInput) {
    // ComfyUI/RMBG 在 6GB 显存 Win 主机上不适合并发执行，这里强制串行，避免互相抢占显存。
    const task = this.cutoutQueue.then(() =>
      this.removeBackgroundInternal(input)
    );
    this.cutoutQueue = task.catch(() => undefined);
    return task;
  }

  private async removeBackgroundInternal(input: PodComfyCutoutInput) {
    const config = input.settings.cutout;
    if (!config?.enabled) {
      return input.buffer;
    }

    const endpoint = this.normalizeEndpoint(config.endpoint);
    const timeoutMs = Number(config.timeoutMs || 180000);
    this.activeCutoutCount += 1;
    try {
      const uploadedName = await this.uploadImage(endpoint, input, timeoutMs);
      const promptId = await this.queuePrompt(
        endpoint,
        uploadedName,
        input.settings,
        timeoutMs
      );
      const output = await this.waitForOutput(endpoint, promptId, timeoutMs);
      const [imageBuffer, maskBuffer] = await Promise.all([
        this.downloadImage(endpoint, output.image, timeoutMs),
        this.downloadImage(endpoint, output.mask, timeoutMs),
      ]);
      return this.composeAlpha(imageBuffer, maskBuffer);
    } finally {
      this.activeCutoutCount = Math.max(0, this.activeCutoutCount - 1);
      await this.freeMemory(endpoint, 'after-cutout', input.context);
    }
  }

  async freeMemoryIfIdle(reason = 'idle-schedule') {
    if (this.activeCutoutCount > 0) {
      return false;
    }
    await this.cutoutQueue.catch(() => undefined);
    if (this.activeCutoutCount > 0) {
      return false;
    }
    const settings = await this.podSettingService.getSettings();
    if (!settings.cutout?.enabled || !settings.cutout?.endpoint) {
      return false;
    }
    await this.freeMemory(
      this.normalizeEndpoint(settings.cutout.endpoint),
      reason
    );
    return true;
  }

  private async freeMemory(
    endpoint: string,
    reason: string,
    context?: PodComfyCutoutInput['context']
  ) {
    const contextText = this.formatContext(context);
    try {
      await axios.post(
        `${endpoint}/free`,
        {
          unload_models: true,
          free_memory: true,
        },
        { timeout: 10000 }
      );
      this.lastFreeAt = Date.now();
      console.info(
        `[POD_COMFY_FREE] reason=${reason} endpoint=${endpoint}${contextText}`
      );
    } catch (err) {
      console.warn(
        `[POD_COMFY_FREE_FAIL] reason=${reason} endpoint=${endpoint}${contextText} err=${
          err?.message || err
        }`
      );
    }
  }

  private async uploadImage(
    endpoint: string,
    input: PodComfyCutoutInput,
    timeoutMs: number
  ) {
    const fileName = `${uuidv4()}-${input.fileName}`;
    const form = new FormData();
    form.append(
      'image',
      new Blob([input.buffer], { type: 'image/png' }),
      fileName
    );
    form.append('type', 'input');
    form.append('overwrite', 'true');

    const res = await axios.post(`${endpoint}/upload/image`, form, {
      timeout: timeoutMs,
    });
    const name = res.data?.name || fileName;
    const subfolder = String(res.data?.subfolder || '').trim();
    return subfolder ? `${subfolder}/${name}` : name;
  }

  private async queuePrompt(
    endpoint: string,
    imageName: string,
    settings: PodModuleSettings,
    timeoutMs: number
  ) {
    const res = await axios.post(
      `${endpoint}/prompt`,
      {
        client_id: uuidv4(),
        prompt: this.buildWorkflow(imageName, settings),
      },
      { timeout: timeoutMs }
    );
    const promptId = res.data?.prompt_id;
    if (!promptId) {
      throw new Error('ComfyUI did not return prompt_id');
    }
    return promptId;
  }

  private async waitForOutput(
    endpoint: string,
    promptId: string,
    timeoutMs: number
  ) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const res = await axios.get(`${endpoint}/history/${promptId}`, {
        timeout: Math.min(timeoutMs, 30000),
      });
      const history = res.data?.[promptId];
      const status = history?.status;
      if (status?.status_str === 'error') {
        throw new Error(this.formatComfyError(status.messages));
      }

      const outputImage = history?.outputs?.['3']?.images?.[0];
      const outputMask = history?.outputs?.['4']?.images?.[0];
      if (outputImage?.filename && outputMask?.filename) {
        return {
          image: outputImage as ComfyOutputImage,
          mask: outputMask as ComfyOutputImage,
        };
      }
      await this.sleep(1000);
    }

    throw new Error('ComfyUI RMBG 黑底抠图超时');
  }

  private formatComfyError(messages: any[]) {
    const executionError = Array.isArray(messages)
      ? messages.find(
          item => Array.isArray(item) && item[0] === 'execution_error'
        )?.[1]
      : null;
    const nodeType =
      executionError?.node_type || executionError?.node_id || 'unknown';
    const message =
      executionError?.exception_message || JSON.stringify(messages || []);
    return `ComfyUI RMBG 黑底抠图失败：${nodeType} ${this.compactText(
      message,
      700
    )}`;
  }

  private compactText(value: any, maxLength: number) {
    const text = String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength)}...`;
  }

  private formatContext(context?: PodComfyCutoutInput['context']) {
    if (!context) {
      return '';
    }
    return [
      context.batchId
        ? ` batch=${context.batchId}/${context.batchNo || '-'}`
        : '',
      context.itemId ? ` item=${context.itemId}/${context.itemNo || '-'}` : '',
      context.fileName
        ? ` file="${this.compactText(context.fileName, 80)}"`
        : '',
    ].join('');
  }

  private async downloadImage(
    endpoint: string,
    image: ComfyOutputImage,
    timeoutMs: number
  ) {
    if (!image?.filename) {
      throw new Error('ComfyUI 黑底抠图未返回最终图或遮罩');
    }

    const res = await axios.get(`${endpoint}/view`, {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      params: {
        filename: image.filename,
        subfolder: image.subfolder || '',
        type: image.type || 'output',
      },
    });
    return Buffer.from(res.data);
  }

  private async composeAlpha(imageBuffer: Buffer, maskBuffer: Buffer) {
    try {
      const imageMetadata = await sharp(imageBuffer).metadata();
      if (imageMetadata.hasAlpha) {
        return sharp(imageBuffer).png().toBuffer();
      }

      const baseImage = await sharp(imageBuffer).removeAlpha().png().toBuffer();
      const metadata = await sharp(baseImage).metadata();
      const width = metadata.width;
      const height = metadata.height;
      if (!width || !height) {
        throw new Error('invalid image dimensions');
      }

      const alpha = await sharp(maskBuffer)
        .resize(width, height, { fit: 'fill' })
        .greyscale()
        .raw()
        .toBuffer();

      return sharp(baseImage)
        .joinChannel(alpha, {
          raw: {
            width,
            height,
            channels: 1,
          },
        })
        .png()
        .toBuffer();
    } catch (err) {
      throw new Error(`ComfyUI 抠图结果透明通道合成失败：${err.message}`);
    }
  }

  private buildWorkflow(imageName: string, settings: PodModuleSettings) {
    const options = this.getCutoutOptions(settings);
    return {
      '1': {
        class_type: 'AILab_LoadImage',
        inputs: {
          image_path_or_URL: '',
          image: imageName,
          upscale_method: 'lanczos',
          megapixels: 0,
          scale_by: 1,
          resize_mode: 'longest_side',
          size: 0,
        },
      },
      '2': {
        class_type: 'RMBG',
        inputs: {
          image: ['1', 0],
          model: options.model,
          sensitivity: 1,
          process_res: options.processRes,
          mask_blur: options.maskBlur,
          mask_offset: options.subjectMaskOffset,
          invert_output: false,
          refine_foreground: true,
          background: 'Alpha',
          background_color: '#222222',
        },
      },
      '3': {
        class_type: 'AILab_ImagePreview',
        inputs: {
          image: ['10', 0],
        },
      },
      '4': {
        class_type: 'AILab_MaskPreview',
        inputs: {
          mask: ['10', 1],
        },
      },
      '5': {
        class_type: 'AILab_Preview',
        inputs: {
          image: ['10', 0],
          mask: ['10', 1],
        },
      },
      '6': {
        class_type: 'AILab_ColorToMask',
        inputs: {
          // 图片模型偶尔会输出黑底图，这里把黑色区域转成辅助遮罩再与 RMBG 主体遮罩合并。
          images: ['1', 0],
          invert: true,
          threshold: options.blackThreshold,
          mask_color: '#000000',
        },
      },
      '7': {
        class_type: 'AILab_MaskEnhancer',
        inputs: {
          mask: ['6', 0],
          sensitivity: 1,
          mask_blur: options.maskBlur,
          mask_offset: 0,
          smooth: 0,
          fill_holes: false,
          invert_output: false,
        },
      },
      '8': {
        class_type: 'AILab_MaskEnhancer',
        inputs: {
          mask: ['2', 1],
          sensitivity: 1,
          mask_blur: options.maskBlur,
          mask_offset: options.subjectMaskOffset,
          smooth: 0,
          fill_holes: true,
          invert_output: false,
        },
      },
      '9': {
        class_type: 'AILab_MaskCombiner',
        inputs: {
          mask_1: ['8', 0],
          mask_2: ['7', 0],
          mode: 'combine',
        },
      },
      '10': {
        class_type: 'AILab_ImageMaskConvert',
        inputs: {
          image: ['2', 0],
          mask: ['9', 0],
          mask_channel: 'alpha',
        },
      },
      '11': {
        class_type: 'AILab_MaskPreview',
        inputs: {
          mask: ['6', 0],
        },
      },
    };
  }

  private getCutoutOptions(settings: PodModuleSettings) {
    const cutout = settings.cutout;
    return {
      model: this.normalizeRmbgModel(cutout?.model),
      blackThreshold: this.intInRange(cutout?.blackThreshold, 34, 0, 255),
      processRes: this.intInRange(cutout?.processRes, 1536, 256, 2048),
      maskBlur: this.intInRange(cutout?.maskBlur, 1, 0, 64),
      subjectMaskOffset: this.intInRange(
        cutout?.subjectMaskOffset,
        -1,
        -64,
        64
      ),
    };
  }

  private normalizeRmbgModel(model: any) {
    const value = String(model || '').trim();
    if (['RMBG-2.0', 'INSPYRENET', 'BEN', 'BEN2'].includes(value)) {
      return value;
    }
    return 'RMBG-2.0';
  }

  private intInRange(value: any, fallback: number, min: number, max: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, Math.trunc(parsed)));
  }

  private normalizeEndpoint(endpoint: string) {
    return String(endpoint || 'http://127.0.0.1:8000').replace(/\/+$/g, '');
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
