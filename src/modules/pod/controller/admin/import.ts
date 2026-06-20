import { Body, Get, Inject, Post, Provide, Query } from '@midwayjs/core';
import { BaseController, CoolController } from '@cool-midway/core';
import { PodGenerationImportEntity } from '../../entity/import';
import { PodGenerationImportService } from '../../service/import';

/**
 * POD表格导入记录
 */
@Provide()
@CoolController({
  api: ['info', 'list', 'page', 'delete'],
  entity: PodGenerationImportEntity,
  service: PodGenerationImportService,
  pageQueryOp: {
    fieldEq: ['a.status'],
    keyWordLikeFields: ['a.importNo', 'a.fileName', 'a.error'],
    addOrderBy: {
      'a.id': 'DESC',
    },
  },
})
export class AdminPodGenerationImportController extends BaseController {
  @Inject()
  podGenerationImportService: PodGenerationImportService;

  @Get('/detail', { summary: '导入详情' })
  async detail(@Query('id') id: number) {
    return this.ok(await this.podGenerationImportService.detail(id));
  }

  @Post('/rows', { summary: '导入行分页' })
  async rows(@Body() body: any) {
    return this.ok(await this.podGenerationImportService.rows(body));
  }
}
