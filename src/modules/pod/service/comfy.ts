import { Provide } from '@midwayjs/core';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { PodModuleSettings } from './setting';

export interface PodComfyCutoutInput {
  buffer: Buffer;
  fileName: string;
  settings: PodModuleSettings;
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
    const promptId = await this.queuePrompt(endpoint, uploadedName, config.model, timeoutMs);
    const image = await this.waitForOutput(endpoint, promptId, timeoutMs);
    return this.downloadImage(endpoint, image, timeoutMs);
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
    model: string,
    timeoutMs: number
  ) {
    const res = await axios.post(
      `${endpoint}/prompt`,
      {
        client_id: uuidv4(),
        prompt: this.buildWorkflow(imageName, model),
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
          `ComfyUI background removal failed: ${JSON.stringify(status.messages || [])}`
        );
      }

      const outputImage = history?.outputs?.['6']?.images?.[0];
      if (outputImage?.filename) {
        return outputImage;
      }
      await this.sleep(1000);
    }

    throw new Error('ComfyUI background removal timed out');
  }

  private async downloadImage(endpoint: string, image: any, timeoutMs: number) {
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

  private buildWorkflow(imageName: string, model: string) {
    return {
      '1': {
        class_type: 'LoadImage',
        inputs: {
          image: imageName,
        },
      },
      '2': {
        class_type: 'LoadBackgroundRemovalModel',
        inputs: {
          bg_removal_name: model || 'birefnet.safetensors',
        },
      },
      '3': {
        class_type: 'RemoveBackground',
        inputs: {
          image: ['1', 0],
          bg_removal_model: ['2', 0],
        },
      },
      '4': {
        class_type: 'InvertMask',
        inputs: {
          mask: ['3', 0],
        },
      },
      '5': {
        class_type: 'JoinImageWithAlpha',
        inputs: {
          image: ['1', 0],
          alpha: ['4', 0],
        },
      },
      '6': {
        class_type: 'SaveImage',
        inputs: {
          images: ['5', 0],
          filename_prefix: `pod-rmbg/${uuidv4()}`,
        },
      },
    };
  }

  private normalizeEndpoint(endpoint: string) {
    return String(endpoint || 'http://127.0.0.1:8000').replace(/\/+$/g, '');
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
