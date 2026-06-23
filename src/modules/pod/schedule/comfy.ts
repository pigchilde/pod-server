import { CommonSchedule, Inject, Provide, TaskLocal } from '@midwayjs/core';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { ILogger } from '@midwayjs/logger';
import { PodGenerationItemEntity } from '../entity/item';
import { PodComfyService } from '../service/comfy';

/**
 * ComfyUI 显存定时释放
 */
@Provide()
export class PodComfySchedule implements CommonSchedule {
  @InjectEntityModel(PodGenerationItemEntity)
  itemEntity: Repository<PodGenerationItemEntity>;

  @Inject()
  podComfyService: PodComfyService;

  @Inject()
  logger: ILogger;

  // Win 主机 6GB 显存容易被 RMBG 缓存占满；每 5 分钟空闲时释放一次，避免影响正在执行的抠图/生图任务。
  @TaskLocal('0 */5 * * * *')
  async exec() {
    const runningCount = await this.itemEntity
      .createQueryBuilder('a')
      .where(
        '(a.status in (:...statuses) or a.cutoutStatus = :cutoutRunning)',
        {
          statuses: ['running', 'cutout_running'],
          cutoutRunning: 'running',
        }
      )
      .getCount();

    if (runningCount > 0) {
      this.logger.info(`[POD_COMFY_FREE_SKIP] runningCount=${runningCount}`);
      return;
    }

    const freed = await this.podComfyService.freeMemoryIfIdle('idle-5min');
    this.logger.info(`[POD_COMFY_FREE_IDLE] freed=${freed}`);
  }
}
