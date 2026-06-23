import { Inject } from '@midwayjs/core';
import { Job, IJob } from '@midwayjs/cron';
import { ILogger } from '@midwayjs/logger';
import { PodGenerationService } from '../service/generation';

let postProcessRunning = false;

/**
 * POD 后处理队列
 *
 * 生图成功后，抠图和效果图由这里独立推进，避免 ComfyUI 或 mockup 慢任务阻塞主生图队列。
 */
@Job({
  cronTime: '*/20 * * * * *',
  start: true,
})
export class PodPostProcessSchedule implements IJob {
  @Inject()
  podGenerationService: PodGenerationService;

  @Inject()
  logger: ILogger;

  async onTick() {
    if (postProcessRunning) {
      this.logger.info('[POD_POST_PROCESS_SKIP] previous tick still running');
      return;
    }

    postProcessRunning = true;
    try {
      const staleCount =
        await this.podGenerationService.recoverStaleProcessingItems();
      const cutoutCount = await this.podGenerationService.processQueuedCutouts({
        limit: 10,
        recoverStale: false,
      });
      const mockupCount = await this.podGenerationService.processQueuedMockups({
        limit: 20,
        concurrency: 2,
        recoverStale: false,
      });

      if (staleCount || cutoutCount || mockupCount) {
        this.logger.info(
          `[POD_POST_PROCESS] stale=${staleCount} cutout=${cutoutCount} mockup=${mockupCount}`
        );
      }
    } finally {
      postProcessRunning = false;
    }
  }
}
