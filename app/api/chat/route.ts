import { createParser, ParsedEvent, ReconnectInterval } from 'eventsource-parser'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

if (typeof ReadableStream === 'undefined') {
  const { ReadableStream } = require('web-streams-polyfill')
  global.ReadableStream = ReadableStream
}

export interface Message {
  role: string
  content: string
  reasoning_content?: string
}

interface ApiConfig {
  apiUrl: string
  apiKey: string
  model: string
  maxTokens: number
}

interface StreamConfig {
  encoder: TextEncoder
  decoder: TextDecoder
  controller: AbortController
}

const TIMEOUT_MS = 30000
const MAX_TOKENS = 4000
const API_ERROR_MESSAGES = {
  DEFAULT: '与 DeepSeek API 通信时发生错误。',
  RATE_LIMIT: '速率限制超出。请稍后重试。',
  INVALID_KEY: 'API 密钥无效。请检查您的配置。',
  BAD_REQUEST: '请求格式无效',
  SERVICE_UNAVAILABLE: 'DeepSeek 服务暂时不可用。请稍后重试。',
  TIMEOUT: '请求超时',
  STREAM_FAILED: '流处理失败',
  PARSE_ERROR: '解析响应数据时发生错误',
  INVALID_MESSAGE_SEQUENCE: '消息序列无效：用户和助手的消息必须交替出现',
  REASONING_CONTENT_NOT_ALLOWED: '消息历史中不允许包含思维链内容'
}

export async function POST(req: NextRequest) {
  try {
    const { prompt, messages, input } = await validateAndParseRequest(req)
    validateNoReasoningContent(messages)
    const messagesWithHistory = buildMessageHistory(prompt, messages, input)
    const apiConfig = getApiConfig()
    const stream = await createDeepSeekStream(apiConfig, messagesWithHistory)
    
    return new Response(stream, {
      headers: new Headers({
        'Content-Type': 'text/event-stream'
      })
    })
  } catch (error) {
    console.error('[API Error]', error)
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { 
        status: error instanceof ApiError ? error.status : 500,
        headers: { 'Content-Type': 'text/event-stream' }
      }
    )
  }
}

function validateNoReasoningContent(messages: Message[]) {
  for (const message of messages) {
    if (message.reasoning_content) {
      throw new ApiError(API_ERROR_MESSAGES.REASONING_CONTENT_NOT_ALLOWED, 400)
    }
  }
}

class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

async function validateAndParseRequest(req: NextRequest) {
  try {
    const data = await req.json()
    const { prompt, messages, input } = data as {
      prompt: string
      messages: Message[]
      input: string
    }
    
    if (!prompt || !Array.isArray(messages) || !input) {
      throw new ApiError('无效的请求参数', 400)
    }
    
    return { prompt, messages, input }
  } catch (error) {
    throw new ApiError('无效的请求参数', 400)
  }
}

function buildMessageHistory(prompt: string, messages: Message[], input: string): Message[] {
  const history = [
    { content: prompt, role: 'system' },
    ...messages,
    { content: input, role: 'user' }
  ]
  
  return normalizeMessages(history)
}

function normalizeMessages(messages: Message[]): Message[] {
  const normalized = messages.reduce((acc: Message[], curr, index) => {
    if (index === 0) {
      acc.push(curr)
      return acc
    }

    const prevMsg = acc[acc.length - 1]
    if (prevMsg.role === curr.role) {
      prevMsg.content = `${prevMsg.content}\n${curr.content}`
    } else {
      acc.push(curr)
    }
    return acc
  }, [])

  validateMessageSequence(normalized)
  return normalized
}

function validateMessageSequence(messages: Message[]) {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) {
      throw new ApiError('消息序列无效：用户和助手的消息必须交替出现', 400)
    }
  }
}

function getApiConfig(): ApiConfig {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new ApiError('API密钥未配置', 500)
  }

  return {
    apiUrl: `${process.env.DEEPSEEKAPI_BASE_URL || 'https://api.deepseek.com'}/v1/chat/completions`,
    apiKey,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    maxTokens: MAX_TOKENS
  }
}

async function makeApiRequest(config: ApiConfig, messages: Message[], controller: AbortController) {
  console.log('[DeepSeek Request Config]', {
    apiUrl: config.apiUrl,
    model: config.model,
    messages: messages.map(m => ({ role: m.role, contentLength: m.content.length })),
    maxTokens: config.maxTokens
  })

  const requestStartTime = Date.now()
  console.log('[DeepSeek Request Start]', new Date(requestStartTime).toISOString())

  const response = await fetch(config.apiUrl, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'api-key': config.apiKey
    },
    method: 'POST',
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: config.maxTokens,
      stream: true
    }),
    signal: controller.signal
  })

  console.log('[DeepSeek Response Time]', Date.now() - requestStartTime, 'ms')
  console.log('[DeepSeek Response Status]', response.status, response.statusText)

  return response
}

async function validateApiResponse(response: Response) {
  if (!response.ok) {
    if (response.status === 401) {
      throw new ApiError(API_ERROR_MESSAGES.INVALID_KEY, 401)
    }
    const errorData = await getErrorData(response)
    throw new ApiError(errorData.message, response.status)
  }
}

async function getErrorData(response: Response) {
  const statusText = response.statusText
  const responseBody = await response.text()
  console.error(`[DeepSeek API Error] ${responseBody}`)

  let message = API_ERROR_MESSAGES.DEFAULT
  try {
    const errorResponse = JSON.parse(responseBody)
    if (errorResponse.error?.message) {
      message = errorResponse.error.message
    }
  } catch {}

  switch (response.status) {
    case 429: return { message: API_ERROR_MESSAGES.RATE_LIMIT }
    case 401: return { message: API_ERROR_MESSAGES.INVALID_KEY }
    case 400: return { message: `${API_ERROR_MESSAGES.BAD_REQUEST}: ${message}` }
    case 503: return { message: API_ERROR_MESSAGES.SERVICE_UNAVAILABLE }
    default: return { message: `${API_ERROR_MESSAGES.DEFAULT} (${response.status} ${statusText}): ${message}` }
  }
}

function handleStreamError(error: unknown) {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      throw new ApiError(API_ERROR_MESSAGES.TIMEOUT, 408)
    }
    throw error
  }
  throw new ApiError(API_ERROR_MESSAGES.STREAM_FAILED, 500)
}

async function createDeepSeekStream(config: ApiConfig, messages: Message[]) {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    console.log('[DeepSeek Request Timeout] Request exceeded', TIMEOUT_MS, 'ms')
    controller.abort()
  }, TIMEOUT_MS)

  try {
    const response = await makeApiRequest(config, messages, controller)
    await validateApiResponse(response)

    if (!response.ok) {
      const errorData = await getErrorData(response)
      throw new ApiError(errorData.message, response.status)
    }

    const streamConfig: StreamConfig = {
      encoder: new TextEncoder(),
      decoder: new TextDecoder(),
      controller
    }

    return createResponseStream(response, streamConfig)
  } catch (error) {
    console.error('[DeepSeek Stream Error]', error)
    if (error instanceof ApiError && error.status === 401) {
      throw new ApiError(API_ERROR_MESSAGES.INVALID_KEY, 401)
    }
    handleStreamError(error)
  } finally {
    clearTimeout(timeout)
  }
}

function createResponseStream(response: Response, config: StreamConfig) {
  const { encoder, decoder } = config

  return new ReadableStream({
    async start(controller) {
      const parser = createParser((event: ParsedEvent | ReconnectInterval) => {
        if (event.type === 'event') {
          const data = event.data
          if (data === '[DONE]' || data === 'keep-alive') {
            if (data === '[DONE]') {
              console.log('[DeepSeek Stream Complete]')
              controller.close()
            } else {
              console.log('[DeepSeek Keep-Alive]')
            }
            return
          }

          try {
            const json = JSON.parse(data)
            const delta = json.choices?.[0]?.delta
            
            if (!delta) {
              console.warn('[DeepSeek Empty Delta]', json)
              return
            }

            console.log('[DeepSeek Response Data]', {
              delta,
              content: delta.content,
              reasoning: delta.reasoning_content
            })
            
            if (delta.reasoning_content) {
              console.log('[DeepSeek Reasoning]', delta.reasoning_content)
              controller.enqueue(encoder.encode(`[Reasoning]${delta.reasoning_content}[/Reasoning]`))
            }
            if (delta.content) {
              console.log('[DeepSeek Content]', delta.content)
              controller.enqueue(encoder.encode(`[Content]${delta.content}[/Content]`))
            }
          } catch (error) {
            console.error('[DeepSeek Parse Error]', error)
            console.error('[DeepSeek Raw Data]', data)
            controller.enqueue(encoder.encode(API_ERROR_MESSAGES.PARSE_ERROR + '\n'))
            controller.close()
          }
        }
      })

      try {
        console.log('[DeepSeek Stream Start] Processing response body')
        if (!response.body) {
          throw new Error('Response body is null')
        }
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const decodedChunk = decoder.decode(value)
          console.log('[DeepSeek Stream Chunk]', decodedChunk)
          parser.feed(decodedChunk)
        }
      } catch (error) {
        console.error('[Stream Processing Error]', error)
        controller.error(new Error(API_ERROR_MESSAGES.STREAM_FAILED))
      }
    }
  })
}
