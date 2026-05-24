import { Column, Entity, Index } from 'typeorm';
import { BaseEntity, transformerJson } from '../../base/entity/base';

/**
 * POD生图批次
 *
 * 批次是一次主题生成任务的聚合根，负责记录主题、数量、输出目录和整体进度。
 */
@Entity('pod_generation_batch')
export class PodGenerationBatchEntity extends BaseEntity {
  @Index()
  @Column({ comment: '批次ID', length: 80 })
  batchNo: string;

  @Column({ comment: '主题', length: 255 })
  topic: string;

  @Index()
  @Column({ comment: '主题标识', length: 120 })
  topicSlug: string;

  @Column({ comment: '数量', default: 0 })
  count: number;

  @Column({ comment: '并发数', default: 3 })
  concurrency: number;

  @Column({ comment: '失败重试次数', default: 1 })
  retries: number;

  @Column({ comment: '单张超时时间(ms)', default: 180000 })
  timeoutMs: number;

  @Index()
  @Column({
    comment: '状态 prompt_generating/prompt_ready/image_generating/completed/partial_failed/failed',
    length: 30,
    default: 'pending',
  })
  status: string;

  @Column({ comment: '成功数', default: 0 })
  successCount: number;

  @Column({ comment: '失败数', default: 0 })
  failedCount: number;

  @Column({ comment: '提示词数量', default: 0 })
  promptCount: number;

  @Column({ comment: '已确认提示词数量', default: 0 })
  approvedPromptCount: number;

  @Column({ comment: '输出目录', nullable: true, length: 500 })
  outputDir: string;

  @Column({
    comment: '扩展配置',
    nullable: true,
    type: 'json',
    transformer: transformerJson,
  })
  options: Record<string, any>;

  @Column({ comment: '错误信息', nullable: true, length: 1000 })
  error: string;
}
