/**
 * tests/customer-prompt.test.js
 * 测试 customer 会议类型的 prompt 生成逻辑
 */

// Mock AWS SDK 避免真实调用
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({})),
  InvokeModelCommand: jest.fn(),
}));

const { getMeetingPrompt } = require('../services/bedrock.js');

const SAMPLE_TRANSCRIPT = '这是一段客户会议转录文本，讨论了云迁移需求。';

describe('Customer Prompt - 必要字段存在', () => {
  let prompt;

  beforeAll(() => {
    prompt = getMeetingPrompt(SAMPLE_TRANSCRIPT, 'customer');
  });

  test('包含 customerNeeds 字段', () => {
    expect(prompt).toContain('customerNeeds');
  });

  test('包含 painPoints 字段', () => {
    expect(prompt).toContain('painPoints');
  });

  test('包含 solutionsDiscussed 字段', () => {
    expect(prompt).toContain('solutionsDiscussed');
  });

  test('包含 commitments 字段', () => {
    expect(prompt).toContain('commitments');
  });

  test('包含 nextSteps 字段', () => {
    expect(prompt).toContain('nextSteps');
  });

  test('meetingType 输出为 customer', () => {
    expect(prompt).toContain('"meetingType": "customer"');
  });

  test('包含转录文本内容', () => {
    expect(prompt).toContain(SAMPLE_TRANSCRIPT);
  });
});

describe('Customer Prompt - party 字段包含 AWS 和客户', () => {
  let prompt;

  beforeAll(() => {
    prompt = getMeetingPrompt(SAMPLE_TRANSCRIPT, 'customer');
  });

  test('party 字段说明中包含 "AWS"', () => {
    expect(prompt).toContain('AWS');
  });

  test('party 字段说明中包含 "客户"', () => {
    expect(prompt).toContain('客户');
  });

  test('commitments 的 party 说明包含 AWS / 客户选项', () => {
    // commitments.party 字段注释：AWS / 客户
    expect(prompt).toMatch(/AWS\s*\/\s*客户/);
  });
});

describe('Customer Prompt - 与其他模板隔离', () => {
  test('general 模板不包含 customerNeeds', () => {
    const generalPrompt = getMeetingPrompt(SAMPLE_TRANSCRIPT, 'general');
    expect(generalPrompt).not.toContain('customerNeeds');
  });

  test('general 模板不包含 painPoints', () => {
    const generalPrompt = getMeetingPrompt(SAMPLE_TRANSCRIPT, 'general');
    expect(generalPrompt).not.toContain('painPoints');
  });

  test('weekly 模板不包含 customerNeeds', () => {
    const weeklyPrompt = getMeetingPrompt(SAMPLE_TRANSCRIPT, 'weekly');
    expect(weeklyPrompt).not.toContain('customerNeeds');
  });

  test('tech 模板不包含 customerNeeds', () => {
    const techPrompt = getMeetingPrompt(SAMPLE_TRANSCRIPT, 'tech');
    expect(techPrompt).not.toContain('customerNeeds');
  });

  test('customer 模板不包含 weekly 特有字段 teamKPI', () => {
    const customerPrompt = getMeetingPrompt(SAMPLE_TRANSCRIPT, 'customer');
    expect(customerPrompt).not.toContain('teamKPI');
  });
});

describe('Customer Prompt - 结构完整性', () => {
  let prompt;

  beforeAll(() => {
    prompt = getMeetingPrompt(SAMPLE_TRANSCRIPT, 'customer');
  });

  test('包含 customerInfo 字段', () => {
    expect(prompt).toContain('customerInfo');
  });

  test('包含 awsAttendees 字段', () => {
    expect(prompt).toContain('awsAttendees');
  });

  test('包含 participants 字段', () => {
    expect(prompt).toContain('participants');
  });

  test('包含 summary 字段', () => {
    expect(prompt).toContain('summary');
  });

  test('prompt 要求只输出 JSON', () => {
    expect(prompt).toContain('只输出 JSON');
  });
});

describe('Customer Prompt - 术语表支持', () => {
  test('有术语表时 prompt 包含专有名词说明', () => {
    const promptWithGlossary = getMeetingPrompt(SAMPLE_TRANSCRIPT, 'customer', ['EKS', 'S3', 'CloudFront']);
    expect(promptWithGlossary).toContain('EKS');
    expect(promptWithGlossary).toContain('S3');
    expect(promptWithGlossary).toContain('CloudFront');
  });

  test('无术语表时 prompt 正常生成（不含词库注释）', () => {
    const promptNoGlossary = getMeetingPrompt(SAMPLE_TRANSCRIPT, 'customer', []);
    expect(promptNoGlossary).toContain('customerNeeds');
    expect(promptNoGlossary).not.toContain('专有名词词库');
  });
});
