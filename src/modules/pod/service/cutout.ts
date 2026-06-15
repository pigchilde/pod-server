import { CoolCommException } from '@cool-midway/core';
import { Inject, Provide } from '@midwayjs/core';
import * as fs from 'fs';
import * as moment from 'moment';
import * as path from 'path';
import * as sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { pGeneratedPath } from '../../../comm/path';
import { PodComfyService } from './comfy';
import { PodSettingService } from './setting';

interface UploadFile {
  filename: string;
  data: string;
}

export interface PodCutoutResult {
  originalName: string;
  fileName?: string;
  filePath?: string;
  imageUrl?: string;
  success: boolean;
  error?: string;
}

/**
 * POD独立抠图工具
 */
@Provide()
export class PodCutoutService {
  @Inject()
  podSettingService: PodSettingService;

  @Inject()
  podComfyService: PodComfyService;

  async upload(files: UploadFile[] = []) {
    if (!files.length) {
      throw new CoolCommException('请至少上传一张图片');
    }

    const settings = await this.podSettingService.getSettings();
    if (!settings.cutout?.enabled) {
      throw new CoolCommException('请先在模块设置中启用 ComfyUI 抠图');
    }

    const dateDir = moment().format('YYYY-MM-DD');
    const outputDir = path.join(pGeneratedPath(), 'cutout', dateDir);
    await fs.promises.mkdir(outputDir, { recursive: true });

    const results: PodCutoutResult[] = [];
    for (const file of files) {
      results.push(await this.cutoutOne(file, outputDir, dateDir, settings));
    }

    return {
      total: files.length,
      success: results.filter(item => item.success).length,
      failed: results.filter(item => !item.success).length,
      outputDir,
      results,
    };
  }

  private async cutoutOne(
    file: UploadFile,
    outputDir: string,
    dateDir: string,
    settings: Awaited<ReturnType<PodSettingService['getSettings']>>
  ): Promise<PodCutoutResult> {
    const originalName = path.basename(file.filename || 'image.png');
    try {
      this.assertImageFile(originalName);

      const buffer = await fs.promises.readFile(file.data);
      const cutoutBuffer = await this.podComfyService.removeBackground({
        buffer,
        fileName: originalName,
        settings,
      });
      const outputBuffer = await this.resizeToOutputSize(cutoutBuffer, settings);
      const fileName = this.createOutputFileName(originalName);
      const filePath = path.join(outputDir, fileName);

      await fs.promises.writeFile(filePath, outputBuffer);

      return {
        originalName,
        fileName,
        filePath,
        imageUrl: path.posix.join('/generated/cutout', dateDir, fileName),
        success: true,
      };
    } catch (err) {
      return {
        originalName,
        success: false,
        error: this.formatDbError(err),
      };
    }
  }


  private formatDbError(err: any) {
    const raw = err?.message || String(err || '未知错误');
    const compact = String(raw).replace(/\s+/g, ' ').trim();
    return compact.length > 950 ? `${compact.slice(0, 950)}...` : compact;
  }

  private assertImageFile(fileName: string) {
    const ext = path.extname(fileName).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      throw new Error('仅支持 png、jpg、jpeg、webp 图片');
    }
  }

  private async resizeToOutputSize(buffer: Buffer, settings: any) {
    const outputSize = String(settings?.generation?.outputSize || '').trim();
    const match = outputSize.match(/^(\d+)x(\d+)$/i);
    if (!match) {
      return sharp(buffer).png().toBuffer();
    }

    const width = Number(match[1]);
    const height = Number(match[2]);
    return sharp(buffer)
      .resize(width, height, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  }

  private createOutputFileName(fileName: string) {
    const name = path.basename(fileName, path.extname(fileName));
    const safeName =
      name
        .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80) || 'cutout';
    return `${moment().format('YYYYMMDDHHmmss')}-${uuidv4().slice(0, 8)}-${safeName}.png`;
  }
}
