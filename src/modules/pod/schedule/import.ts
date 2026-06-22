import { CommonSchedule, Inject, Provide, TaskLocal } from '@midwayjs/core';
import { ILogger } from '@midwayjs/logger';
import { PodGenerationService } from '../service/generation';

/**
 * POD导入任务恢复
 */
@Provide()
export class PodImportSchedule implements CommonSchedule {
  @Inject()
  podGenerationService: PodGenerationService;

  @Inject()
  logger: ILogger;

  // 导入任务由后台进程串行消费；定时扫描避免 Win 主机重启或 PM2 reload 后任务长期卡住。
  @TaskLocal('30 */5 * * * *')
  async exec() {
    const count = await this.podGenerationService.recoverImportTasks({
      staleMinutes: 30,
      limit: 5,
    });
    if (count > 0) {
      this.logger.info(`[POD_IMPORT_RECOVER] count=${count}`);
    }
  }
}
