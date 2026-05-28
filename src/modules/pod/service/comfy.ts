import { Provide } from '@midwayjs/core';
import axios from 'axios';
import * as sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { PodModuleSettings } from './setting';

export interface PodComfyCutoutInput {
  buffer: Buffer;
  fileName: string;
  settings: PodModuleSettings;
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
  async removeBackground(input: PodComfyCutoutInput) {
    const config = input.settings.cutout;
    if (!config?.enabled) {
      return input.buffer;
    }

    const endpoint = this.normalizeEndpoint(config.endpoint);
    const timeoutMs = Number(config.timeoutMs || 180000);
    const uploadedName = await this.uploadImage(endpoint, input, timeoutMs);
    const promptId = await this.queuePrompt(endpoint, uploadedName, input.settings, timeoutMs);
    const output = await this.waitForOutput(endpoint, promptId, timeoutMs);
    const [imageBuffer, maskBuffer] = await Promise.all([
      this.downloadImage(endpoint, output.image, timeoutMs),
      this.downloadImage(endpoint, output.mask, timeoutMs),
    ]);
    return this.composeAlpha(imageBuffer, maskBuffer);
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
    return res.data?.name || fileName;
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

  private async waitForOutput(endpoint: string, promptId: string, timeoutMs: number) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const res = await axios.get(`${endpoint}/history/${promptId}`, {
        timeout: Math.min(timeoutMs, 30000),
      });
      const history = res.data?.[promptId];
      const status = history?.status;
      if (status?.status_str === 'error') {
        throw new Error(
          `ComfyUI RMBG 黑底抠图失败：${JSON.stringify(status.messages || [])}`
        );
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
      subjectMaskOffset: this.intInRange(cutout?.subjectMaskOffset, -1, -64, 64),
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
