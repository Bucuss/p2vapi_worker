
var MODEL_List = {
  "gpt-4": "gpt-4",
  "gpt-4-32k": "gpt-4-mobile",
  "gpt-3.5-turbo": "text-davinci-002-render-sha"
};
var all_New_Text = "";
var p2vapi_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    let response;
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With"
    };
    if (method === "OPTIONS") {
      response = new Response("OK", { headers, status: 200 });
      return response;
    }
    switch (path) {
      case "/image/upload":
        response = method === "PUT" ? await handleR2request(request, env) : methodNotAllowed();
        break;
      case "/v1/chat/completions":
        response = method === "POST" ? await handleChatCompletions(request, env) : methodNotAllowed();
        break;
      default:
        response = notFoundResponse();
    }
    response = new Response(response.body, response);
    Object.keys(headers).forEach((key) => {
      response.headers.set(key, headers[key]);
    });
    return response;
  }
};
function generateUniqueId(prefix) {
  const randomUuid = crypto.randomUUID();
  const randomUuidStr = randomUuid.replace(/-/g, "");
  const uniqueId = `${prefix}-${randomUuidStr}`;
  return uniqueId;
}
function generatePayload(model, formattedMessages) {
  const commonPayload = {
    model,
    action: "next",
    messages: formattedMessages,
    parent_message_id: crypto.randomUUID(),
    // 使用 crypto API 生成 UUID
    timezone_offset_min: -480,
    history_and_training_disabled: false,
    conversation_mode: { kind: "primary_assistant" },
    suggestions: [],
    force_paragen: false,
    force_rate_limit: false
    //arkose_token: null
  };
  return commonPayload;
}
async function downloadAndSaveImage(image_url, headers, env) {
  async function handleR2putimage(data, env2) {
    const dir = "image/";
    const currentDate = Math.floor(Date.now() / 1e3);
    const objectName = dir + currentDate;
    const data_headers = {};
    const object = await env2.R2buket.put(objectName, data, {
      httpMetadata: data_headers
    });
    console.log(`object: ${JSON.stringify(object)}`);
    const imageurl = `${env2.R2_DOMAIN}/${objectName}`;
    return new Response(imageurl, {
      headers: {
        "Content-Type": "text/plain"
      }
    });
  }
  try {
    const response = await fetch(image_url, { headers });
    if (!response.ok) {
      throw new Error(`get image download url fail: ${response.statusText}`);
    }
    const data = await response.json();
    const download_url = data.download_url;
    console.log(`download_url: ${download_url}`);
    const downloadResponse = await fetch(download_url);
    if (!downloadResponse.ok) {
      throw new Error(`download fail: ${downloadResponse.statusText}`);
    }
    console.log("download success");
    const blob = await downloadResponse.blob();
    const saveResponse = await handleR2putimage(blob, env);
    if (!saveResponse.ok) {
      throw new Error("Network response was not ok");
    }
    const savedImageUrl = await saveResponse.text();
    console.log(`savedImageUrl: ${savedImageUrl}`);
    return savedImageUrl;
  } catch (error) {
    console.error("There was a problem with your operation:", error);
    throw error;
  }
}
function isValidCitationFormat(text) {
  const regexFullValidCitation = /\u3010\d+\u2020(source|\u6765\u6e90)\u3011\u3010?/;
  const regexPartialValidCitation = /\u3010(\d+)?(\u2020(source|\u6765\u6e90)?)?/;
  return regexFullValidCitation.test(text) || regexPartialValidCitation.test(text);
}
function isCompleteCitationFormat(text) {
  const regexCompleteCitation = /\u3010\d+\u2020(source|\u6765\u6e90)\u3011\u3010?/;
  return regexCompleteCitation.test(text);
}
function replaceCompleteCitation(text, citations) {
  const regexCitation = /\u3010(\d+)\u2020(source|\u6765\u6e90)\u3011/g;
  let replacedText = text;
  let remainingText = "";
  const match = regexCitation.exec(text);
  if (match) {
    const citationNumber = parseInt(match[1]);
    const citation = citations.find((c) => c.metadata?.extra?.cited_message_idx === citationNumber);
    if (citation) {
      const url = citation.metadata?.url || "";
      replacedText = text.replace(regexCitation, `[[${citationNumber}](${url})]`);
      remainingText = text.substring(match.index + match[0].length);
    }
  }
  const isPotentialCitation = isValidCitationFormat(remainingText);
  if (isPotentialCitation) {
    replacedText = replacedText.slice(0, -remainingText.length);
  }
  return [replacedText, remainingText, isPotentialCitation];
}
async function* processResponse(env, messages, response, apikey) {
  const reader = response.body.getReader();
  let buffer = "";
  let chat_message_id = generateUniqueId("chatcmpl");
  let timestamp = Math.floor(Date.now() / 1e3);
  let last_full_text = "";
  let last_full_code = "";
  let last_full_code_result = "";
  let last_content_type = "";
  let conversation_id = "";
  let citation_buffer = "";
  let citation_accumulating = false;
  let full_text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      console.log("Stream completed");
      break;
    }
    buffer += new TextDecoder("utf-8").decode(value);
    buffer = buffer.includes("data:") ? "data:" + buffer.split("data:").slice(-1)[0] : buffer;
    while (buffer.includes("data:") && buffer.includes("\n\n")) {
      const end_index = buffer.indexOf("\n\n") + 2;
      const complete_data = buffer.substring(0, end_index);
      buffer = buffer.substring(end_index);
      try {
        const data_json = JSON.parse(complete_data.replace("data: ", ""));
        const message = data_json.message || {};
        const message_status = message.status;
        const content = message.content || {};
        const role = message.author ? message.author.role : "";
        const content_type = content.content_type;
        const name = message.author ? message.author.name : "";
        let metadata = message.metadata || {};
        let citations = metadata.citations || [];
        let new_text = "";
        let IMGMESSAGE = false;
        const parts = content.parts || [];
        conversation_id = data_json.conversation_id;
        if (role === "user" || role === "system" || message_status === "finished_successfully" && role !== "tool") {
          continue;
        }
        for (const part of parts) {
          if (part.content_type === "image_asset_pointer") {
            IMGMESSAGE = true;
            const asset_pointer = part.asset_pointer.replace("file-service://", "");
            console.log(`asset_pointer: ${asset_pointer}`);
            const image_url = `${env.BASE_URL}/${env.PROXY_API_PREFIX}/backend-api/files/${asset_pointer}/download`;
            const headers = {
              "Authorization": `Bearer ${apikey}`
            };
            const savedImageUrl = await downloadAndSaveImage(image_url, headers, env);
            if (last_content_type === "code" && content_type !== void 0) {
              new_text = `
\`\`\`

![image](${savedImageUrl})
[DownloadLink](${savedImageUrl})
`;
            } else {
              new_text = `
![image](${savedImageUrl})
[DownloadLink](${savedImageUrl})
`;
            }
            console.log(`imagetext:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
          }
        }
        if (IMGMESSAGE === false) {
          console.log(`content_type: ${content_type};last_content_type: ${last_content_type}`);
          if (content_type === "multimodal_text" && last_content_type === "code") {
            new_text = "\n```\n" + (content?.text || "");
            console.log(`multimodal_text:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
          } else if (role === "tool" && name === "dalle.text2im") {
            continue;
          }
          if (content_type === "code" && last_content_type !== "code" && last_content_type !== null) {
            const full_code = content?.text || "";
            const language = content?.language && content.language !== "unknown" ? content.language : "shell";
            new_text = `
\`\`\`${language}
` + full_code.substring(last_full_code.length);
            console.log(`code:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
            last_full_code = full_code;
          } else if (content_type !== "code" && last_content_type === "code" && content_type !== null) {
            const full_code = content?.text || "";
            if (last_full_code !== "") {
              new_text = "\n```\n" + full_code.substring(last_full_code.length);
            }
            console.log(`code:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
            last_full_code = "";
          } else if (content_type === "code" && last_content_type === "code") {
            const full_code = content?.text || "";
            new_text = full_code.substring(last_full_code.length);
            last_full_code = full_code;
          } else {
            const parts2 = content.parts || [];
            full_text = parts2.join("");
            console.log(`full_text: ${full_text}`);
            new_text = full_text.substring(last_full_text.length);
            console.log(`text:new_text: ${new_text}`);
            last_full_text = full_text;
            if (new_text.includes("\u3010") && !citation_accumulating) {
              citation_accumulating = true;
              citation_buffer = citation_buffer + new_text;
            } else if (citation_accumulating) {
              citation_buffer += new_text;
            }
            if (citation_accumulating) {
              if (isValidCitationFormat(citation_buffer)) {
                if (isCompleteCitationFormat(citation_buffer)) {
                  let [replacedText, remainingText, isPotentialCitation] = replaceCompleteCitation(citation_buffer, citations);
                  new_text = replacedText;
                  if (isPotentialCitation) {
                    citation_buffer = remainingText;
                  } else {
                    citation_accumulating = false;
                    citation_buffer = "";
                  }
                } else {
                  continue;
                }
              } else {
                new_text = citation_buffer;
                citation_accumulating = false;
                citation_buffer = "";
              }
            }
          }
          if (role === "tool" && name === "python" && last_content_type !== "execution_output" && content_type !== null) {
            const full_code_result = content?.text || "";
            new_text = full_code_result.substring(last_full_code_result.length);
            if (last_content_type === "code") {
              new_text = new_text + "\n```\n`Result:`\n\n```\n";
            }
            console.log(`text:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
            last_full_code_result = full_code_result;
          } else if (last_content_type === "execution_output" && (role !== "tool" && name !== "python") && content_type !== null) {
            const full_code_result = content?.text || "";
            new_text = full_code_result.substring(last_full_code_result.length);
            if (content_type === "text") {
              new_text = "\n```\n" + new_text;
            }
            console.log(`text:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
            last_full_code_result = "";
          } else if (last_content_type === "execution_output" && role === "tool" && name === "python" && content_type !== null) {
            const full_code_result = content?.text || "";
            new_text = full_code_result.substring(last_full_code_result.length);
            if (message.status === "finished_successfully") {
              new_text = new_text + "\n```\n";
            }
            console.log(`text:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
            last_full_code_result = full_code_result;
          }
        }
        last_content_type = role !== "user" ? content_type : last_content_type;
        const newData = {
          id: chat_message_id,
          object: "chat.completion.chunk",
          created: timestamp,
          model: message.metadata?.model_slug,
          choices: [
            {
              index: 0,
              delta: {
                content: new_text
              },
              finish_reason: null
            }
          ]
        };
        const tmp = `data: ${JSON.stringify(newData)}

`;
        all_New_Text += new_text;
        yield tmp;
      } catch (error) {
        if (complete_data === "data: [DONE]\n\n") {
          yield complete_data;
          break;
        }
      }
    }
  }
  console.log(`citation_buffer: ${citation_buffer}`);
  if (citation_buffer !== "") {
    const newData = {
      id: chat_message_id,
      object: "chat.completion.chunk",
      created: timestamp,
      model: messages.metadata?.model_slug,
      choices: [
        {
          index: 0,
          delta: {
            content: citation_buffer
          },
          finish_reason: null
        }
      ]
    };
    const tmp = `data: ${JSON.stringify(newData)}

`;
    all_New_Text += citation_buffer;
    yield tmp;
  }
  if (buffer) {
    try {
      await deleteConversation(env, conversation_id, apikey);
      let bufferJson = JSON.parse(buffer);
      const errorMessage = bufferJson.detail?.message || "unknown error";
      const errorData = {
        id: chat_message_id,
        object: "chat.completion.chunk",
        created: timestamp,
        model: "error",
        choices: [
          {
            index: 0,
            delta: {
              content: `"""
${errorMessage}
"""`
              // 使用模板字符串来处理多行字符串
            },
            finish_reason: null
          }
        ]
      };
      const tmp = `data: ${JSON.stringify(errorData)}

`;
      all_New_Text += "```\n" + { errorMessage } + "\n```";
      yield tmp;
    } catch (error) {
      await deleteConversation(env, conversation_id, apikey);
    }
  }
  console.log(`conversation id ${conversation_id}`);
  if (conversation_id !== "") {
    await deleteConversation(env, conversation_id, apikey);
  }
}
async function sendTextPromptAndGetResponse(env, messages, apiKey, model) {
  const url = `${env.BASE_URL}/${env.PROXY_API_PREFIX}/backend-api/conversation`;
  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  const formattedMessages = messages.map((message) => ({
    id: crypto.randomUUID(),
    // 使用 JavaScript 的 crypto API 生成 UUID
    author: { role: message.role },
    content: { content_type: "text", parts: [message.content] },
    metadata: {}
    // Add an empty object as the value for the metadata property
  }));
  console.log(`formattedMessages: ${JSON.stringify(formattedMessages)}`);
  let payload = null;
  if (MODEL_List.hasOwnProperty(model)) {
    const modelList = MODEL_List;
    payload = generatePayload(modelList[model], formattedMessages);
  } else {
    if (!payload) {
      throw new Error("model is not accessible");
    }
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  return response;
}
async function deleteConversation(env, conversationId, apiKey) {
  const currentDate = (/* @__PURE__ */ new Date()).toISOString();
  console.log(`[${currentDate}] delete conversationId ${conversationId}`);
  if (conversationId) {
    const patchUrl = `${env.BASE_URL}/${env.PROXY_API_PREFIX}/backend-api/conversation/${conversationId}`;
    const patchHeaders = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    };
    const patchData = JSON.stringify({ is_visible: false });
    try {
      const response = await fetch(patchUrl, {
        method: "PATCH",
        headers: patchHeaders,
        body: patchData
      });
      if (response.ok) {
        console.log(`[${currentDate}] delete conversation ${conversationId} success`);
        return new Response(`delete conversation ${conversationId} success`, { status: 200 });
      } else {
        console.log(`[${currentDate}] PATCH failed: ${response.statusText}`);
        return new Response(`PATCH failed: ${response.statusText}`, { status: response.status });
      }
    } catch (error) {
      console.error(`[${currentDate}] request error: ${error}`);
      return new Response(`request error: ${error}`, { status: 500 });
    }
  }
  return new Response("unvaild conversation id", { status: 400 });
}
function methodNotAllowed() {
  return new Response("Method Not Allowed", { status: 405 });
}
function notFoundResponse() {
  return new Response("Not Found", { status: 404 });
}
async function handleR2request(request, env) {
  const dir = "image/";
  const currentDate = Math.floor(Date.now() / 1e3);
  const objectName = dir + currentDate;
  if (request.method === "PUT" || request.method == "POST") {
    const object = await env.R2buket.put(objectName, request.body, {
      httpMetadata: request.headers
    });
    console.log(`object: ${JSON.stringify(object)}`);
    const imageurl = `${env.R2_DOMAIN}/${objectName}`;
    return new Response(imageurl, {
      headers: {
        "Content-Type": "text/plain"
      }
    });
  }
  return new Response(`Unsupported method`, {
    status: 400
  });
}
async function handleChatCompletions(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const data = await request.json();
  const messages = data.messages;
  const model = data.model;
  if (!MODEL_List.hasOwnProperty(model)) {
    return new Response(JSON.stringify({ error: "model is not accessible" }), { status: 401 });
  }
  const stream = data.stream;
  console.log(`stream: ${stream}`);
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Authorization header is missing or invalid" }), { status: 401 });
  }
  const apiKey = authHeader.split(" ")[1];
  const upstreamResponse = await sendTextPromptAndGetResponse(env, messages, apiKey, model);
  if (stream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    (async () => {
      for await (const item of processResponse(env, messages, upstreamResponse, apiKey)) {
        await writer.write(encoder.encode(item));
      }
      writer.close();
    })();
    all_New_Text = "";
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  } else {
    for await (const item of processResponse(env, messages, upstreamResponse, apiKey)) {
    }
    console.log(`all_New_Text: ${all_New_Text}`);
    const responseJson = {
      "id": generateUniqueId("chatcmpl"),
      "object": "chat.completion",
      "created": Math.floor(Date.now() / 1e3),
      "model": model,
      "choices": [
        {
          "index": 0,
          "message": {
            "role": "assistant",
            "content": all_New_Text
          },
          "finish_reason": "stop"
        }
      ],
      "usage": {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0
      },
      "system_fingerprint": null
    };
    all_New_Text = "";
    return new Response(JSON.stringify(responseJson), { headers: { "Content-Type": "application/json" } });
  }
}
export {
  p2vapi_default as default
};
//# sourceMappingURL=p2vapi.js.map
