//环境变量
export interface Env {
	R2buket: R2Bucket;
	BASE_URL: string;
	PROXY_API_PREFIX: string;
	R2_DOMAIN:string;

}
//模型映射
const MODEL_List = {
    "gpt-4": "gpt-4",
    "gpt-4-32k": "gpt-4-mobile",
    "gpt-3.5-turbo": "text-davinci-002-render-sha"

}
let all_New_Text = ""; //累计流式响应内容

export default {
    async fetch(request: Request, env: Env) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;
        let response: Response;
        const headers: { [key: string]: string } = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With'
        };
        
        
        if (method === 'OPTIONS') {
            response =  new Response('OK', { headers:headers , status: 200 });
            return response;
        }

        // 路由处理
        switch (path) {
            case '/image/upload':
                response = method === 'PUT' ? await handleR2request(request,env) : methodNotAllowed();
                break;
            case '/v1/chat/completions':
                response = method === 'POST' ? await handleChatCompletions(request,env) : methodNotAllowed();
                break;
            default:
                response = notFoundResponse();
        }
        
        response = new Response(response.body, response);
        //添加跨域头
        Object.keys(headers).forEach(key => {
            response.headers.set(key, headers[key]);
        });

        return response;
    },
};


function generateUniqueId(prefix: string) {
    // 生成一个随机的 UUID
    const randomUuid = crypto.randomUUID();
    // 将 UUID 转换为字符串，并移除其中的短横线
    const randomUuidStr = randomUuid.replace(/-/g, '');
    // 结合前缀和处理过的 UUID 生成最终的唯一 ID
    const uniqueId = `${prefix}-${randomUuidStr}`;
    return uniqueId;
}

//生成普通模型payload
function generatePayload(model: string, formattedMessages: any[]) {
    const commonPayload = {
        model: model,
        action: "next",
        messages: formattedMessages,
        parent_message_id: crypto.randomUUID(), // 使用 crypto API 生成 UUID
        timezone_offset_min: -480,
        history_and_training_disabled: false,
        conversation_mode: { kind: "primary_assistant" },
        suggestions: [],
        force_paragen: false,
        force_rate_limit: false,
        //arkose_token: null
    };
    return commonPayload;
}


//下载并保存图片到R2
async function downloadAndSaveImage(image_url:string, headers:any,env:Env) {
    //请求上传图片
    async function handleR2putimage(data: any,env:Env){
        const dir = "image/"
        const currentDate  = Math.floor(Date.now() / 1000)
        const objectName = dir+currentDate
        const data_headers = {}
            const object = await env.R2buket.put(objectName, data, {
                httpMetadata: data_headers,
            })
            console.log(`object: ${JSON.stringify(object)}`)
            const imageurl = `${env.R2_DOMAIN}/${objectName}`
            return new Response(imageurl, {
                headers: {
                    'Content-Type': 'text/plain',
                }
            })
    }
    // 请求图片下载地址
    try {
        const response = await fetch(image_url, { headers });
        if (!response.ok) {
            throw new Error(`get image download url fail: ${response.statusText}`);
        }

        const data:any= await response.json();
        const download_url = data.download_url;
        console.log(`download_url: ${download_url}`);

        const downloadResponse = await fetch(download_url);
        if (!downloadResponse.ok) {
            throw new Error(`download fail: ${downloadResponse.statusText}`);
        }

        console.log('download success');
        const blob = await downloadResponse.blob();

        const saveResponse = await handleR2putimage(blob,env);
        if (!saveResponse.ok) {
            throw new Error('Network response was not ok');
        }

        const savedImageUrl = await saveResponse.text();
        console.log(`savedImageUrl: ${savedImageUrl}`);

        return savedImageUrl; // 返回一个包含必要信息的对象
    } catch (error) {
        console.error('There was a problem with your operation:', error);
        throw error; // 抛出错误以便调用者能够捕获
    }
}
// 辅助函数：检查是否为合法的引用格式或正在构建中的引用格式
function isValidCitationFormat(text: string): boolean {
    const regexFullValidCitation = /\u3010\d+\u2020(source|\u6765\u6e90)\u3011\u3010?/;
    const regexPartialValidCitation = /\u3010(\d+)?(\u2020(source|\u6765\u6e90)?)?/;
    return regexFullValidCitation.test(text) || regexPartialValidCitation.test(text);
}

// 辅助函数：检查是否为完整的引用格式
function isCompleteCitationFormat(text: string): boolean {
    const regexCompleteCitation = /\u3010\d+\u2020(source|\u6765\u6e90)\u3011\u3010?/;
    return regexCompleteCitation.test(text);
}

// 替换完整的引用格式
function replaceCompleteCitation(text: string, citations: any[]): [string, string, boolean] {
    const regexCitation = /\u3010(\d+)\u2020(source|\u6765\u6e90)\u3011/g;
    let replacedText = text;
    let remainingText = "";

    const match = regexCitation.exec(text);
    if (match) {
        const citationNumber = parseInt(match[1]);
        const citation = citations.find(c => c.metadata?.extra?.cited_message_idx === citationNumber);
        
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



async function* processResponse(env:Env,messages: any, response: any, apikey: string): AsyncIterableIterator<string> {

    const reader = response.body.getReader();
    let buffer = '';
    let chat_message_id = generateUniqueId("chatcmpl");
    let timestamp = Math.floor(Date.now() / 1000);
    let last_full_text = ""; //记录所有parts中出现的文本
    let last_full_code = ""; //记录所有parts中出现的code
    let last_full_code_result = "" //记录所有parts中出现的执行结果
    let last_content_type = "";//用于记录上一个消息的内容类型
    let conversation_id = ''; // 用于记录会话 ID
    let citation_buffer = ""; // 临时积累用于积累引用内容
    let citation_accumulating = false; // 用于标记是否正在积累引用内容
    let full_text = ""; // 用于记录所有parts中出现的文本

    
    //每轮buffer内部的处理逻辑
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            console.log("Stream completed");
            break;
        }
        buffer += new TextDecoder("utf-8").decode(value);
        //console.log(`Received data chunk of size: ${value.length}`);
        //console.log(`Received data chunk : ${buffer}`);
        //处理多data:标签问题
        buffer = buffer.includes('data:') ? "data:"+buffer.split('data:').slice(-1)[0]  : buffer;
        //console.log(`Received after data chunk : ${buffer}`);
       // console.log(`after buffer: ${buffer}`)
        while (buffer.includes('data:') && buffer.includes('\n\n')) {
            const end_index = buffer.indexOf('\n\n') + 2;
            const complete_data = buffer.substring(0, end_index);
            buffer = buffer.substring(end_index);
            

            try {
                const data_json = JSON.parse(complete_data.replace('data: ', ''));
                const message = data_json.message || {};
                const message_status = message.status;
                const content = message.content || {};
                const role = message.author ? message.author.role : "";
                const content_type = content.content_type;
                const name = message.author ? message.author.name : "";
                let metadata = message.metadata || {};
                let citations = (metadata as { citations?: any[] }).citations || [];
                let new_text = "";
                let IMGMESSAGE = false;
                const parts = content.parts || [];
                conversation_id = data_json.conversation_id;

                //只处理assistant和tool的消息
                //处理 message_status === "finished_successfully 避免重复发送已完成的消息 tool消息保留(各种工具结果)
                if ((role === "user" || role === "system") || (message_status === "finished_successfully" && role !== "tool")) {
                    continue;
                }
                
                
                //单独处理图片消息，获取图片url
                for (const part of parts) {
                    //console.log(`content part: ${JSON.stringify(part)}`);
                    if (part.content_type === 'image_asset_pointer') {
                        IMGMESSAGE = true;
                        const asset_pointer = part.asset_pointer.replace('file-service://', '');
                        console.log(`asset_pointer: ${asset_pointer}`);
                        const image_url = `${env.BASE_URL}/${env.PROXY_API_PREFIX}/backend-api/files/${asset_pointer}/download`;
                        const headers = {
                            "Authorization": `Bearer ${apikey}`
                        };
                        const savedImageUrl = await downloadAndSaveImage(image_url, headers,env);
                        if (last_content_type === "code"&&content_type!==undefined) {
                        	new_text = "\n```\n"+`\n![image](${savedImageUrl})\n[DownloadLink](${savedImageUrl})\n`;
                            
                        }else{
                            new_text = `\n![image](${savedImageUrl})\n[DownloadLink](${savedImageUrl})\n`;
                        }
                        
                        
                        console.log(`imagetext:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`)
                    }

                }
                //没有图片消息的处理逻辑
                if (IMGMESSAGE === false) {
                    // 处理多模态文本

                    console.log(`content_type: ${content_type};last_content_type: ${last_content_type}`)
                    if (content_type === "multimodal_text" && last_content_type === "code") {
                        new_text = "\n```\n" + (content?.text || "");
                        console.log(`multimodal_text:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
                    }
                    else if (role === "tool" && name === "dalle.text2im") {
                        
                        continue;
                    }
                    
                    // 处理代码块
                    if (content_type === "code" && last_content_type !== "code" &&last_content_type !== null) {
                        const full_code = (content?.text || "");
                        const language = (content?.language && content.language !== "unknown") ? content.language : "shell";
                        //可能重复解析
                        new_text = `\n\`\`\`${language}\n` + full_code.substring(last_full_code.length);
                        console.log(`code:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
                        last_full_code = full_code; // 代码开始输出
                    }

                    else if (content_type !== "code" && last_content_type === "code"&& content_type !== null) {
                        const full_code = (content?.text || "");
                        if(last_full_code!==""){
                            new_text = "\n```\n" +full_code.substring(last_full_code.length)
                        }
                        console.log(`code:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
                        last_full_code = ""; // 代码输出结束
                    }

                    else if (content_type === "code" && last_content_type === "code") {
                        const full_code = (content?.text || "");
                        new_text = full_code.substring(last_full_code.length);
                       // console.log(`code:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
                        last_full_code = full_code; // 代码输出中
                    }

                    else {
                        //text文本处理逻辑
                        const parts = content.parts || [];
                        full_text = parts.join('');
                        console.log(`full_text: ${full_text}`);
                        new_text = full_text.substring(last_full_text.length);
                        console.log(`text:new_text: ${new_text}`)
                        last_full_text = full_text;// 更新完整文本以备下次比较 // 使用 '.substring()' 方法截取

                        //引用处理
                        if (new_text.includes("【") && !citation_accumulating) {
                            citation_accumulating = true;
                            citation_buffer = citation_buffer + new_text;
                            // console.log(`开始积累引用: ${citationBuffer}`);
                        } else if (citation_accumulating) {
                            citation_buffer += new_text;
                            // console.log(`积累引用: ${citationBuffer}`);
                        }

                        if (citation_accumulating) {
                            if (isValidCitationFormat(citation_buffer)) {
                                // console.log(`合法格式: ${citationBuffer}`);
                                // 继续积累
                                if (isCompleteCitationFormat(citation_buffer)) {

                                    // 替换完整的引用格式
                                    let [replacedText, remainingText, isPotentialCitation] = replaceCompleteCitation(citation_buffer, citations);
                                    // console.log(replacedText);  // 输出替换后的文本
                                    new_text = replacedText;
                                    
                                    if(isPotentialCitation) {
                                        citation_buffer = remainingText;
                                    } else {
                                        citation_accumulating = false;
                                        citation_buffer = "";
                                    }
                                    // console.log(`替换完整的引用格式: ${new_text}`);
                                } else {
                                    continue;
                                }
                            } else {
                                // 不是合法格式，放弃积累并响应
                                // console.log(`不合法格式: ${citationBuffer}`);
                                new_text = citation_buffer;
                                citation_accumulating = false;
                                citation_buffer = "";
                            }
                        }

                        

                    }
                    //处理代码解释器内容
                    if(role === "tool" && name === "python" && last_content_type !== "execution_output" && content_type !== null){
                        const full_code_result = (content?.text || "");
                        new_text = full_code_result.substring(last_full_code_result.length);
                        if(last_content_type==="code"){
                            new_text =  new_text+"\n```\n"+"`Result:`\n\n"+"```\n"
                        }
                        console.log(`text:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
                        last_full_code_result = full_code_result 
                    }
                    else if (last_content_type === "execution_output" && (role !== "tool" && name !== "python") && content_type !==null) {
                        const full_code_result = (content?.text || "");
                        new_text = full_code_result.substring(last_full_code_result.length)
                        if(content_type==="text"){
                            new_text = "\n```\n"+new_text
                        }
                        console.log(`text:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
                        last_full_code_result = ""
                    }
                    else if (last_content_type === "execution_output" && role === "tool" && name === "python" && content_type !==null) {
                        const full_code_result = (content?.text || "");
                        new_text = full_code_result.substring(last_full_code_result.length)
                        if(message.status==="finished_successfully"){
                            new_text = new_text+"\n```\n"
                        }
                        console.log(`text:new_text: ${new_text};last_content_type: ${last_content_type};content_type: ${content_type}`);
                        last_full_code_result = full_code_result
                    }
                }
                //更新 last_content_type
                //console.log(`2content_type: ${content_type};last_content_type: ${last_content_type}`)
                last_content_type = role !== "user" ? content_type : last_content_type;
                // if (content_type !== null) {
                //console.log(`3content_type: ${content_type};last_content_type: ${last_content_type}`)
                // }
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
                const tmp = `data: ${JSON.stringify(newData)}\n\n`;
                //console.log(`Sending data chunk: ${JSON.stringify(newData)}`);
                all_New_Text += new_text
                yield tmp



            } catch (error) {
                if (complete_data === 'data: [DONE]\n\n') {
                    yield complete_data
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
        const tmp = `data: ${JSON.stringify(newData)}\n\n`;
        all_New_Text += citation_buffer
        yield tmp
    }
    if (buffer) {
        try {
            await deleteConversation(env,conversation_id, apikey);
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
                            content: `"""\n${errorMessage}\n"""` // 使用模板字符串来处理多行字符串
                        },
                        finish_reason: null
                    }
                ]
            };

            const tmp = `data: ${JSON.stringify(errorData)}\n\n`;
            all_New_Text += "```\n" + { errorMessage } + "\n```"
            yield tmp
        } catch (error) {

            await deleteConversation(env,conversation_id, apikey);
        }
    }
    console.log(`conversation id ${conversation_id}`);
    if(conversation_id!==""){   
        await deleteConversation(env,conversation_id, apikey);
    }
    
}


async function sendTextPromptAndGetResponse(env:Env,messages: any[], apiKey: string, model: string){
    const url = `${env.BASE_URL}/${env.PROXY_API_PREFIX}/backend-api/conversation`;
    const headers = {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": 'application/json'
    };

    const formattedMessages = messages.map(message => ({
        id: crypto.randomUUID(),  // 使用 JavaScript 的 crypto API 生成 UUID
        author: { role: message.role },
        content: { content_type: "text", parts: [message.content] },
        metadata: {} 
    }));

    console.log(`formattedMessages: ${JSON.stringify(formattedMessages)}`);
    let payload = null;
    if (MODEL_List.hasOwnProperty(model)) {
        const modelList: { [key: string]: string } = MODEL_List;
        payload = generatePayload(modelList[model], formattedMessages);
    }
    else {
        // payload = generateGptsPayload(model, formattedMessages);
        if (!payload) {
            throw new Error('model is not accessible');
        }
    }

    // 使用 fetch API 发送请求
    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload),
    });

    
    return response;

}

async function deleteConversation(env:Env,conversationId: string, apiKey: string): Promise<Response>{
    const currentDate = new Date().toISOString();
    console.log(`[${currentDate}] delete conversationId ${conversationId}`);
    if (conversationId) {
        const patchUrl = `${env.BASE_URL}/${env.PROXY_API_PREFIX}/backend-api/conversation/${conversationId}`;
        const patchHeaders = {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        };
        const patchData = JSON.stringify({ is_visible: false });

        try {
            const response = await fetch(patchUrl, {
                method: 'PATCH',
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
    return new Response('unvaild conversation id', { status: 400 });
}


// 返回 405 方法不允许的响应
function methodNotAllowed() {
    return new Response('Method Not Allowed', { status: 405 });
}

// 返回 404 未找到的响应
function notFoundResponse() {
    return new Response('Not Found', { status: 404 });
}

// 具体端点处理逻辑
async function handleR2request(request: any,env:Env){
    const dir = "image/"
    const currentDate  = Math.floor(Date.now() / 1000)
    const objectName = dir+currentDate

    //保存图片
    if (request.method === 'PUT' || request.method == 'POST') {
        // console.log(`objectName: ${objectName} && url:${url}`)
        const object = await env.R2buket.put(objectName, request.body, {
            httpMetadata: request.headers,
        })
        console.log(`object: ${JSON.stringify(object)}`)
        const imageurl = `${env.R2_DOMAIN}/${objectName}`
        return new Response(imageurl, {
            headers: {
                'Content-Type': 'text/plain',
            }
        })
    }

    return new Response(`Unsupported method`, {
        status: 400
    })

}

async function handleChatCompletions(request: any,env:Env) {
    // 只允许 POST 方法
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 })
    }

    const data = await request.json();
    const messages = data.messages;
    const model = data.model;
    if (!MODEL_List.hasOwnProperty(model)) {
        return new Response(JSON.stringify({ error: 'model is not accessible' }), { status: 401 })
    }

    const stream = data.stream;
    console.log(`stream: ${stream}`)
    // 检查授权头
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Authorization header is missing or invalid' }), { status: 401 })
    }
    const apiKey = authHeader.split(' ')[1];
    //sendTextPromptAndGetResponse和processResponse并行处理 一边拿返回数据一边处理
    const upstreamResponse = await sendTextPromptAndGetResponse(env,messages, apiKey, model)

    //流式响应
    if (stream) {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        //拿到内容就转发
        (async () => {
           
            for await (const item of processResponse(env, messages, upstreamResponse, apiKey)) {
                await writer.write(encoder.encode(item));
            }
            writer.close();
        })();
        all_New_Text = ""
        return new Response(readable, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                
            }
        });
    }
    //非流式响应
    else {

        for await (const item of processResponse(env,messages, upstreamResponse, apiKey)) {}

        console.log(`all_New_Text: ${all_New_Text}`)
        const responseJson = {
            "id": generateUniqueId("chatcmpl"),
            "object": "chat.completion",
            "created": Math.floor(Date.now() / 1000),
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
        //all_New_Text = "" 
        return new Response(JSON.stringify(responseJson), { headers: { 'Content-Type': 'application/json' } });
    }

}