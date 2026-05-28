import { Provide } from '@midwayjs/core';
import * as fs from 'fs';
import * as path from 'path';
import * as sharp from 'sharp';

export interface PodGenerateMockupInput {
  printFileName: string;
  printFilePath: string;
  batchOutputDir: string;
  batchPublicDir: string;
}

export interface PodGenerateMockupResult {
  mockupFileName: string;
  mockupFilePath: string;
  mockupImageUrl: string;
}

/**
 * POD T恤效果图生成
 */
@Provide()
export class PodMockupService {
  async generate(input: PodGenerateMockupInput): Promise<PodGenerateMockupResult> {
    // T.png 放在 temu-tshirt 根目录，批次目录结构为 temu-tshirt/日期/主题。
    const templatePath = path.join(input.batchOutputDir, '..', '..', 'T.png');
    if (!fs.existsSync(templatePath)) {
      throw new Error(`T恤模板不存在：${templatePath}`);
    }
    if (!input.printFilePath || !fs.existsSync(input.printFilePath)) {
      throw new Error('印花图片文件不存在，请先生成或抠图');
    }

    const template = sharp(templatePath).rotate();
    const templateMeta = await template.metadata();
    const templateWidth = templateMeta.width;
    const templateHeight = templateMeta.height;
    if (!templateWidth || !templateHeight) {
      throw new Error('T恤模板尺寸无效');
    }

    const maxPrintWidth = Math.round(templateWidth * 0.52);
    const maxPrintHeight = Math.round(templateHeight * 0.42);
    const printBuffer = await sharp(input.printFilePath)
      .rotate()
      .resize(maxPrintWidth, maxPrintHeight, {
        fit: 'inside',
        kernel: 'lanczos3',
      })
      .png()
      .toBuffer();
    const printMeta = await sharp(printBuffer).metadata();
    const printWidth = printMeta.width || maxPrintWidth;
    const printHeight = printMeta.height || maxPrintHeight;
    const left = Math.max(0, Math.round((templateWidth - printWidth) / 2));
    const top = Math.max(
      0,
      Math.min(
        Math.round(templateHeight * 0.3),
        templateHeight - printHeight
      )
    );

    const outputDir = path.join(input.batchOutputDir, 'tshirt-effects');
    await fs.promises.mkdir(outputDir, { recursive: true });
    const baseName = path.parse(input.printFileName || input.printFilePath).name;
    const mockupFileName = `${baseName}.jpg`;
    const mockupFilePath = path.join(outputDir, mockupFileName);

    await sharp(templatePath)
      .rotate()
      .composite([{ input: printBuffer, left, top }])
      .jpeg({ quality: 92 })
      .toFile(mockupFilePath);

    return {
      mockupFileName,
      mockupFilePath,
      mockupImageUrl: path.posix.join(input.batchPublicDir, 'tshirt-effects', mockupFileName),
    };
  }
}
