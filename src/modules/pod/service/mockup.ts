import { Config, Provide } from '@midwayjs/core';
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
  @Config('module.pod.mockup')
  mockupConfig;

  async generate(
    input: PodGenerateMockupInput
  ): Promise<PodGenerateMockupResult> {
    // 默认从输出根目录读取 T.png，也支持通过 POD_MOCKUP_TEMPLATE_PATH 显式配置模板。
    const templatePath = this.resolveTemplatePath(input.batchOutputDir);
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

    const options = this.getLayoutOptions();
    const maxPrintWidth = Math.round(
      templateWidth * options.maxPrintWidthRatio
    );
    const maxPrintHeight = Math.round(
      templateHeight * options.maxPrintHeightRatio
    );
    // 印花图通常是 2048 方图，必须先等比压进胸前区域，否则会盖住衣领和袖口。
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
    // T.png 当前是平铺黑色 T 恤，0.3 的纵向比例大致落在胸前印花区。
    const top = Math.max(
      0,
      Math.min(
        Math.round(templateHeight * options.topRatio),
        templateHeight - printHeight
      )
    );

    const outputDir = path.join(input.batchOutputDir, 'tshirt-effects');
    await fs.promises.mkdir(outputDir, { recursive: true });
    const baseName = path.parse(
      input.printFileName || input.printFilePath
    ).name;
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
      mockupImageUrl: path.posix.join(
        input.batchPublicDir,
        'tshirt-effects',
        mockupFileName
      ),
    };
  }

  private resolveTemplatePath(batchOutputDir: string) {
    const configured = String(this.mockupConfig?.templatePath || '').trim();
    if (configured) {
      return path.isAbsolute(configured)
        ? configured
        : path.resolve(process.cwd(), configured);
    }
    return path.join(batchOutputDir, '..', '..', 'T.png');
  }

  private getLayoutOptions() {
    return {
      maxPrintWidthRatio: this.ratio(
        this.mockupConfig?.maxPrintWidthRatio,
        0.52
      ),
      maxPrintHeightRatio: this.ratio(
        this.mockupConfig?.maxPrintHeightRatio,
        0.42
      ),
      topRatio: this.ratio(this.mockupConfig?.topRatio, 0.3),
    };
  }

  private ratio(value: any, fallback: number) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 && num <= 1 ? num : fallback;
  }
}
