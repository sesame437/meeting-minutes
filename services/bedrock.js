const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");

const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION,
});

const DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-4-6";

async function invokeModel(prompt, modelId = DEFAULT_MODEL_ID) {
  const resp = await bedrockClient.send(
    new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    })
  );

  const result = JSON.parse(new TextDecoder().decode(resp.body));
  return result.content[0].text;
}

module.exports = { invokeModel };
