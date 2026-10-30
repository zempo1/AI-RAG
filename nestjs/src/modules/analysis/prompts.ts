export function analysisPrompt(type: string, content: string): string {
  if (type === 'SUMMARY')
    return (
      '请对以下文档进行结构化摘要，使用 Markdown 格式输出。' +
      '要求：\n' +
      '1. 首先用一句话概括文档主题\n' +
      '2. 然后分 3-5 个核心要点（加粗标题 + 简洁说明）\n' +
      '3. 最后给出一句总结\n' +
      '只输出 Markdown 正文，不要额外解释。\n\n' +
      '文档内容：\n\n' +
      content
    );
  if (type === 'OUTLINE')
    return (
      '请根据以下文档内容生成层级大纲，使用 Markdown ATX 标题格式（# ## ###）。' +
      '要求：\n' +
      '1. 提取文档的主要章节和子章节\n' +
      '2. 每个标题下可用简短一行描述该章节主要内容\n' +
      '3. 层级不超过 3 级\n' +
      '只输出 Markdown 大纲，不要额外解释。\n\n' +
      '文档内容：\n\n' +
      content
    );
  if (type === 'FLASHCARD')
    return (
      '请根据以下文档内容生成 10-15 张知识点问答卡片（Flashcard），严格按照 JSON 数组格式输出。\n' +
      '要求：\n' +
      '1. 每张卡片包含 "q"（问题）和 "a"（答案）两个字段\n' +
      '2. 问题应简明扼要，考查核心知识点\n' +
      '3. 答案应完整准确，100字以内\n' +
      '4. 覆盖文档的重要概念、定义、流程等\n' +
      '只输出 JSON 数组，不要任何其他文字或代码块标记，格式示例：\n' +
      '[{"q":"问题1","a":"答案1"},{"q":"问题2","a":"答案2"}]\n\n' +
      '文档内容：\n\n' +
      content
    );
  throw new Error('Unknown analysis type: ' + type);
}

export function mindMapPrompt(content: string): string {
  return (
    'Generate a mind map structure based on the following text. ' +
    'The output must be a valid JSON object strictly following this format: ' +
    '{ "root": { "data": { "text": "Main Topic" }, "children": [ { "data": { "text": "Subtopic" }, "children": [] } ] } }. ' +
    'Do not include any markdown formatting (like ```json). Just the raw JSON string. ' +
    'Text content: \n\n' +
    content
  );
}
