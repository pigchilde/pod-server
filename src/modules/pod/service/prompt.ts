import { Provide } from '@midwayjs/core';

export interface PodPromptItem {
  itemNo: string;
  prompt: string;
  seoFileName: string;
  subTheme: string;
}

/**
 * POD提示词生成
 *
 * 当前主流程已切换为 DeepSeek 生成提示词，本服务保留为本地兜底工具：
 * 当外部 LLM 不可用或需要快速造测试数据时，可以复用这里的安全清洗和 slug 逻辑。
 */
@Provide()
export class PodPromptService {
  private readonly bannedWords = [
    'disney',
    'marvel',
    'pokemon',
    'pikachu',
    'nike',
    'adidas',
    'nba',
    'nfl',
    'celebrity',
  ];

  private readonly subjects = [
    'cowboy cat',
    'rodeo cat',
    'sheriff cat',
    'desert cat',
    'saloon cat',
    'outlaw cat',
    'bandana cat',
    'western kitten',
    'ranch cat',
    'cactus cat',
  ];

  private readonly styles = [
    'vintage distressed',
    'retro hand drawn',
    'bold vector',
    'cute cartoon',
    'old west poster',
    'screen print friendly',
    'high contrast',
    'weathered ink',
    'rustic badge',
    'classic rodeo',
  ];

  private readonly layouts = [
    'centered T-shirt print',
    'isolated apparel graphic',
    'badge style shirt design',
    'stacked typography print',
    'round emblem T-shirt art',
  ];

  create(topic: string, count: number): PodPromptItem[] {
    // 本地兜底生成不会调用外部模型，内容较模板化，不建议作为正式生产 Prompt。
    const safeTopic = this.cleanTopic(topic);
    const items: PodPromptItem[] = [];
    const used = new Set<string>();

    for (let i = 0; i < count; i++) {
      const subject = this.subjects[i % this.subjects.length];
      const style = this.styles[(i * 2) % this.styles.length];
      const layout = this.layouts[(i * 3) % this.layouts.length];
      const subTheme = `${subject} ${style}`;
      const prompt = [
        `${subTheme}, inspired by ${safeTopic}`,
        layout,
        'transparent background, clean silhouette, POD ready',
        'high contrast, screen print friendly, no mockup, no shirt, no model',
        'no watermark, no brand logo, no copyrighted characters',
      ].join(', ');

      let seoFileName = this.slugify(`${subTheme} tshirt print`);
      while (used.has(seoFileName)) {
        seoFileName = `${seoFileName}-${i + 1}`;
      }
      used.add(seoFileName);

      items.push({
        itemNo: String(i + 1).padStart(3, '0'),
        prompt: this.removeBannedWords(prompt),
        seoFileName,
        subTheme,
      });
    }

    return items;
  }

  slugify(value: string) {
    // 文件名和 URL 片段统一走这里，避免中文、空格和特殊字符造成路径问题。
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .filter(Boolean)
      .slice(0, 10)
      .join('-');
  }

  private cleanTopic(topic: string) {
    const fallback = 'funny vintage T-shirt print';
    return this.removeBannedWords(topic || fallback);
  }

  private removeBannedWords(value: string) {
    // 基础敏感词清洗，只作为兜底防线；正式 Prompt 仍依赖 DeepSeek 的安全规则。
    return this.bannedWords.reduce((text, word) => {
      return text.replace(new RegExp(word, 'gi'), '').replace(/\s+/g, ' ');
    }, value);
  }
}
