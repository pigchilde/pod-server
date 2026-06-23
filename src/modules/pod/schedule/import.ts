import { Inject } from '@midwayjs/core';
import { Job, IJob } from '@midwayjs/cron';
import { ILogger } from '@midwayjs/logger';
import { PodGenerationService } from '../service/generation';

/**
 * POD导入任务恢复
 */
@Job({
  cronTime: '30 */5 * * * *',
  start: true,
})
export class PodImportSchedule implements IJob {
  @Inject()
  podGenerationService: PodGenerationService;

  @Inject()
  logger: ILogger;

  async onTick() {
    const count = await this.podGenerationService.recoverImportTasks({
      staleMinutes: 30,
      limit: 5,
    });
    if (count > 0) {
      this.logger.info(`[POD_IMPORT_RECOVER] count=${count}`);
    }
  }
}
