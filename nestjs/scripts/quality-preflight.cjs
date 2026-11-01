// Read-only by default: no model calls, no database writes, no automatic downloads.
require('dotenv/config');
const { ConfigService } = require('@nestjs/config');
const { TokenizerService } = require('../dist/modules/embeddings/tokenizer.service');
const samples = [
  'A tokenizer calibration sentence.',
  '中文标定：权限校验与知识库检索。',
  'TS-999 API/v2 version 1.2.3',
];
const live = process.argv.includes('--live');
(async () => {
  const config = new ConfigService(process.env);
  const tokenizer = new TokenizerService(config);
  const report = {
    live,
    note: '能够加载本地 tokenizer 不等于与远端模型精确匹配；样本 usage 对比也不能证明所有文本均匹配。',
    embedding: {},
    chat: {},
  };
  for (const [kind, field] of [
    ['embedding', 'EMBEDDING_TOKENIZER'],
    ['chat', 'CHAT_TOKENIZER'],
  ]) {
    const id = config.get(field) || 'estimate:utf8-v1';
    const result = (report[kind] = {
      configured: !!id,
      local_loadable: false,
      verified: false,
      status: id === 'estimate:utf8-v1' ? 'conservative_estimate' : 'requires_verification',
      counting_mode: id === 'estimate:utf8-v1' ? 'utf8_bytes_estimate' : 'local_tokenizer',
      operator_note: config.get(field + '_ATTESTATION') || null,
    });
    if (!id) {
      result.error = field + ' 未配置';
      continue;
    }
    try {
      result.sample_counts = await Promise.all(samples.map((text) => tokenizer.count(text, id)));
      result.local_loadable = true;
    } catch (error) {
      result.error = error.message;
    }
  }
  if (live) {
    const model = config.get('EMBEDDING_MODEL') || 'qwen3.7-text-embedding-flash';
    const key = config.get('EMBEDDING_API_KEY');
    if (!key || !report.embedding.local_loadable)
      report.embedding.live_error = '缺少密钥或可加载 tokenizer，不执行付费校准';
    else {
      try {
        const observed = [];
        for (const text of samples) {
          const response = await fetch(
            (
              config.get('EMBEDDING_BASE_URL') ||
              'https://dashscope.aliyuncs.com/compatible-mode/v1'
            ).replace(/\/$/, '') + '/embeddings',
            {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                input: [text],
                dimensions: Number(config.get('EMBEDDING_DIMENSIONS') || 1024),
              }),
              signal: AbortSignal.timeout(30000),
            },
          );
          if (!response.ok) throw new Error('Embedding HTTP ' + response.status);
          const body = await response.json();
          observed.push(body.usage?.prompt_tokens ?? body.usage?.total_tokens ?? null);
        }
        report.embedding.provider_sample_usage = observed;
        report.embedding.sample_usage_matches = observed.every(
          (count, i) => count !== null && count === report.embedding.sample_counts[i],
        );
        report.embedding.status = report.embedding.sample_usage_matches
          ? 'sample_usage_matches_requires_verification'
          : 'sample_usage_mismatch';
      } catch (error) {
        report.embedding.live_error = error.message;
      }
    }
    report.chat.live_note =
      '聊天 usage 含消息 framing 和特殊 token，不能将纯正文 count 与 prompt_tokens 直接判等；请使用该模型官方 tokenizer 与 chat template 校准。';
  }
  console.log(JSON.stringify(report, null, 2));
  if (
    !report.embedding.local_loadable ||
    !report.chat.local_loadable ||
    report.embedding.sample_usage_matches === false
  )
    process.exitCode = 1;
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
