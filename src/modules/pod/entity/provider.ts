import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../base/entity/base';

/**
 * POD供应商配置
 */
@Entity('pod_provider_config')
export class PodProviderConfigEntity extends BaseEntity {
  @Column({ comment: '供应商名称', length: 80 })
  name: string;

  @Column({ comment: '供应商标识', length: 60 })
  code: string;

  @Index()
  @Column({ comment: '供应商类型 image/prompt', length: 20 })
  type: string;

  @Index()
  @Column({ comment: '是否启用', default: true })
  enabled: boolean;

  @Column({ comment: '协议 openai-images/mock/openai-chat/anthropic-messages', length: 40 })
  protocol: string;

  @Column({ comment: '接口地址', nullable: true, length: 500 })
  endpoint: string;

  @Column({ comment: 'API Key', nullable: true, length: 500 })
  apiKey: string;

  @Column({ comment: '模型', nullable: true, length: 120 })
  model: string;

  @Column({ comment: '默认并发数', default: 3 })
  concurrency: number;

  @Column({ comment: '排序', default: 0 })
  orderNum: number;

  @Column({ comment: '备注', nullable: true, length: 500 })
  remark: string;
}
