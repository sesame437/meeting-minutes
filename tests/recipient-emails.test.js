/**
 * tests/recipient-emails.test.js
 * 测试收件人邮箱解析逻辑
 */

// 邮箱验证正则（与实际业务逻辑保持一致）
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 解析收件人邮箱列表
 * - 输入：逗号分隔的字符串 或 数组
 * - 输出：有效邮箱数组
 * - 无效/空输入 → 返回空数组（调用方负责 fallback 到环境变量）
 */
function parseRecipientEmails(input) {
  if (!input) return [];

  let emails;
  if (Array.isArray(input)) {
    emails = input;
  } else if (typeof input === 'string') {
    emails = input.split(',').map(e => e.trim()).filter(e => e.length > 0);
  } else {
    return [];
  }

  return emails.filter(email => EMAIL_REGEX.test(email));
}

/**
 * 获取最终收件人列表（含 fallback 到环境变量逻辑）
 */
function resolveRecipients(recipientEmails, envEmail) {
  const parsed = parseRecipientEmails(recipientEmails);
  if (parsed.length > 0) {
    return parsed;
  }
  // fallback 到环境变量
  if (envEmail) {
    return [envEmail];
  }
  return [];
}

describe('收件人邮箱 - 有效邮箱解析', () => {
  test('单个有效邮箱', () => {
    expect(parseRecipientEmails('user@example.com')).toEqual(['user@example.com']);
  });

  test('逗号分隔的多个有效邮箱', () => {
    const result = parseRecipientEmails('alice@aws.com,bob@aws.com,carol@aws.com');
    expect(result).toEqual(['alice@aws.com', 'bob@aws.com', 'carol@aws.com']);
  });

  test('有空格的逗号分隔邮箱', () => {
    const result = parseRecipientEmails('alice@aws.com, bob@aws.com, carol@aws.com');
    expect(result).toEqual(['alice@aws.com', 'bob@aws.com', 'carol@aws.com']);
  });

  test('数组形式直接传入', () => {
    const result = parseRecipientEmails(['alice@aws.com', 'bob@aws.com']);
    expect(result).toEqual(['alice@aws.com', 'bob@aws.com']);
  });
});

describe('收件人邮箱 - 无效邮箱过滤', () => {
  test('缺少 @ 的邮箱被过滤', () => {
    expect(parseRecipientEmails('notanemail')).toEqual([]);
  });

  test('缺少域名的邮箱被过滤', () => {
    expect(parseRecipientEmails('user@')).toEqual([]);
  });

  test('纯数字被过滤', () => {
    expect(parseRecipientEmails('12345')).toEqual([]);
  });

  test('混合有效/无效邮箱 → 只保留有效的', () => {
    const result = parseRecipientEmails('valid@aws.com,notanemail,also-invalid,another@valid.com');
    expect(result).toEqual(['valid@aws.com', 'another@valid.com']);
  });

  test('全部无效时返回空数组', () => {
    expect(parseRecipientEmails('bad1,bad2,bad3')).toEqual([]);
  });
});

describe('收件人邮箱 - 空输入处理', () => {
  test('null 输入返回空数组', () => {
    expect(parseRecipientEmails(null)).toEqual([]);
  });

  test('undefined 输入返回空数组', () => {
    expect(parseRecipientEmails(undefined)).toEqual([]);
  });

  test('空字符串返回空数组', () => {
    expect(parseRecipientEmails('')).toEqual([]);
  });

  test('空数组返回空数组', () => {
    expect(parseRecipientEmails([])).toEqual([]);
  });
});

describe('收件人邮箱 - Fallback 到环境变量', () => {
  test('有有效邮箱时使用指定邮箱，不 fallback', () => {
    const result = resolveRecipients('user@example.com', 'env@fallback.com');
    expect(result).toEqual(['user@example.com']);
  });

  test('空输入时 fallback 到环境变量', () => {
    const result = resolveRecipients('', 'env@fallback.com');
    expect(result).toEqual(['env@fallback.com']);
  });

  test('null 输入时 fallback 到环境变量', () => {
    const result = resolveRecipients(null, 'env@fallback.com');
    expect(result).toEqual(['env@fallback.com']);
  });

  test('全部无效邮箱时 fallback 到环境变量', () => {
    const result = resolveRecipients('notvalid,alsoinvalid', 'env@fallback.com');
    expect(result).toEqual(['env@fallback.com']);
  });

  test('无有效邮箱且无环境变量时返回空数组', () => {
    const result = resolveRecipients(null, null);
    expect(result).toEqual([]);
  });

  test('多个有效邮箱时全部使用，不 fallback', () => {
    const result = resolveRecipients('a@x.com,b@x.com', 'env@fallback.com');
    expect(result).toEqual(['a@x.com', 'b@x.com']);
  });
});
