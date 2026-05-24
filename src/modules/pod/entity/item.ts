import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../base/entity/base';

/**
 * POD生图任务项
 *
 * 每条记录对应一张最终图片：先保存 DeepSeek 生成的 Prompt，再在用户确认后调用图片模型。
 */
@Entity('pod_generation_item')
export class PodGenerationItemEntity extends BaseEntity {
  @Index()
  @Column({ comment: '批次ID' })
  batchId: number;

  @Index()
  @Column({ comment: '任务编号', length: 20 })
  itemNo: string;

  @Column({ comment: '子主题', nullable: true, length: 120 })
  subTheme: string;

  @Column({ comment: '提示词来源', nullable: true, length: 30 })
  promptSource: string;

  @Index()
  @Column({
    comment: '提示词状态 draft/approved/rejected',
    length: 30,
    default: 'draft',
  })
  promptStatus: string;

  @Column({ comment: '生图提示词', type: 'text' })
  prompt: string;

  @Column({ comment: 'SEO标题', nullable: true, length: 180 })
  seoTitle: string;

  @Column({ comment: '标签', nullable: true, length: 500 })
  tags: string;

  @Index()
  @Column({ comment: 'SEO文件名', length: 160 })
  seoFileName: string;

  @Column({ comment: '文件名', nullable: true, length: 220 })
  fileName: string;

  @Column({ comment: '文件路径', nullable: true, length: 500 })
  filePath: string;

  @Column({ comment: '图片访问地址', nullable: true, length: 500 })
  imageUrl: string;

  @Index()
  @Column({
    comment: '状态 pending/running/success/failed',
    length: 30,
    default: 'pending',
  })
  status: string;

  @Column({ comment: '尝试次数', default: 0 })
  attempts: number;

  @Column({ comment: '耗时(ms)', nullable: true })
  durationMs: number;

  @Column({ comment: '错误信息', nullable: true, length: 1000 })
  error: string;
}
