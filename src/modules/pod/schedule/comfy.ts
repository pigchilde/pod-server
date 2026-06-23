import { Inject } from '@midwayjs/core';
import { Job, IJob } from '@midwayjs/cron';
import { InjectEntityModel } from '@midwayjs/typeorm';
import { Repository } from 'typeorm';
import { ILogger } from '@midwayjs/logger';
import { PodGenerationItemEntity } from '../entity/item';
import { PodComfyService } from '../service/comfy';

/**
 * ComfyUI 显存定时释放
 */
@Job({
  cronTime: '0 */5 * * * *',
  start: true,
})
export class PodComfySchedule implements IJob {
  @InjectEntityModel(PodGenerationItemEntity)
  itemEntity: Repository<PodGenerationItemEntity>;

  @Inject()
  podComfyService: PodComfyService;

  @Inject()
  logger: ILogger;

  async onTick() {
    const runningCount = await this.itemEntity
      .createQueryBuilder('a')
      .where('(a.status = :status or a.cutoutStatus = :cutoutRunning)', {
        status: 'running',
        cutoutRunning: 'running',
      })
      .getCount();

    if (runningCount > 0) {
      this.logger.info(`[POD_COMFY_FREE_SKIP] runningCount=${runningCount}`);
      return;
    }

    const freed = await this.podComfyService.freeMemoryIfIdle('idle-5min');
    this.logger.info(`[POD_COMFY_FREE_IDLE] freed=${freed}`);
  }
}
