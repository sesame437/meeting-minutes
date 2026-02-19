/**
 * tests/pipeline-stage.test.js
 * 测试 Pipeline Stage 字段逻辑
 */

// Stage 枚举定义（与 worker 代码保持一致）
const VALID_STAGES = ['transcribing', 'reporting', 'generating', 'exporting', 'sending', 'done', 'failed'];

// 前端文字描述映射（与 UI 层约定一致）
function getStageLabel(stage) {
  const labels = {
    transcribing: '转录中…',
    reporting:    '生成报告中…',
    generating:   '生成报告中…',
    exporting:    '导出中…',
    sending:      '发送邮件中…',
    done:         '已完成',
    failed:       '处理失败',
  };
  return labels[stage] || '处理中…';
}

// 判断是否为"活跃中"状态（用于轮询逻辑）
function isActiveStage(stage) {
  return ['transcribing', 'reporting', 'generating', 'exporting', 'sending'].includes(stage);
}

describe('Pipeline Stage - 枚举值', () => {
  test('包含所有预期 stage 值', () => {
    const expected = ['transcribing', 'reporting', 'generating', 'exporting', 'sending', 'done', 'failed'];
    expected.forEach(s => {
      expect(VALID_STAGES).toContain(s);
    });
  });

  test('stage 数量正确（7个）', () => {
    expect(VALID_STAGES).toHaveLength(7);
  });

  test('不包含拼写错误的值', () => {
    expect(VALID_STAGES).not.toContain('transcribed');
    expect(VALID_STAGES).not.toContain('complete');
    expect(VALID_STAGES).not.toContain('completed');
    expect(VALID_STAGES).not.toContain('export');
  });
});

describe('Pipeline Stage - 前端文字描述映射', () => {
  test('transcribing → 转录中…', () => {
    expect(getStageLabel('transcribing')).toBe('转录中…');
  });

  test('reporting → 生成报告中…', () => {
    expect(getStageLabel('reporting')).toBe('生成报告中…');
  });

  test('generating → 生成报告中…', () => {
    expect(getStageLabel('generating')).toBe('生成报告中…');
  });

  test('exporting → 导出中…', () => {
    expect(getStageLabel('exporting')).toBe('导出中…');
  });

  test('sending → 发送邮件中…', () => {
    expect(getStageLabel('sending')).toBe('发送邮件中…');
  });

  test('done → 已完成', () => {
    expect(getStageLabel('done')).toBe('已完成');
  });

  test('failed → 处理失败', () => {
    expect(getStageLabel('failed')).toBe('处理失败');
  });
});

describe('Pipeline Stage - Unknown stage fallback', () => {
  test('未知 stage 返回默认描述', () => {
    expect(getStageLabel('unknown')).toBe('处理中…');
  });

  test('null stage 有 fallback', () => {
    expect(getStageLabel(null)).toBe('处理中…');
  });

  test('undefined stage 有 fallback', () => {
    expect(getStageLabel(undefined)).toBe('处理中…');
  });

  test('空字符串 stage 有 fallback', () => {
    expect(getStageLabel('')).toBe('处理中…');
  });
});

describe('Pipeline Stage - 活跃状态判断', () => {
  test('transcribing 是活跃状态', () => {
    expect(isActiveStage('transcribing')).toBe(true);
  });

  test('sending 是活跃状态', () => {
    expect(isActiveStage('sending')).toBe(true);
  });

  test('done 不是活跃状态', () => {
    expect(isActiveStage('done')).toBe(false);
  });

  test('failed 不是活跃状态', () => {
    expect(isActiveStage('failed')).toBe(false);
  });
});
