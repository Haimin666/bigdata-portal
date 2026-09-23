<template>
  <ion-page class="assistant-page">
    <ion-header class="ion-no-border">
      <ion-toolbar>
        <ion-title>{{ activeThread?.title || '开发助手' }}</ion-title>
        <ion-buttons slot="end">
          <ion-button class="assistant-head-button" aria-label="历史会话" @click="openHistory">
            <ion-icon :icon="timeOutline" />
          </ion-button>
          <ion-button class="assistant-head-button" aria-label="新建对话" :disabled="streaming" @click="newConversation">
            <ion-icon :icon="addOutline" />
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content ref="contentRef" class="assistant-content" :scroll-events="true" @ionScroll="trackScroll">
      <main class="assistant-body">
        <div v-if="loading" class="assistant-loading"><ion-spinner name="crescent" /><span>正在连接开发助手…</span></div>
        <div v-else-if="error && !messages.length" class="assistant-error-state">
          <ion-icon :icon="chatbubbleEllipsesOutline" />
          <strong>暂时无法连接助手</strong>
          <span>{{ error }}</span>
          <ion-button fill="outline" size="small" @click="initialize">重试连接</ion-button>
        </div>
        <template v-else>
          <section v-if="!messages.length" class="assistant-welcome">
            <span class="assistant-mark"><ion-icon :icon="sparklesOutline" /></span>
            <p class="eyebrow">DATadeck · DEV ASSISTANT</p>
            <h2>你好，今天想解决什么？</h2>
            <p class="welcome-copy">可以问代码、数据或开发问题。回复会边生成边显示。</p>
            <div class="prompt-suggestions">
              <button v-for="prompt in suggestions" :key="prompt" @click="draft = prompt">{{ prompt }}<ion-icon :icon="chevronBackOutline" /></button>
            </div>
          </section>
          <section v-else class="assistant-messages" aria-live="polite" aria-relevant="additions text">
            <article v-for="message in messages" :key="message.id" class="chat-row" :class="message.role">
              <span v-if="message.role === 'assistant'" class="assistant-avatar"><ion-icon :icon="sparklesOutline" /></span>
              <div class="chat-bubble">
                <div v-if="message.content" class="message-content">{{ message.content }}</div>
                <div v-if="message.role === 'assistant' && message.status" class="message-status">
                  <ion-spinner v-if="message.streaming" name="dots" />
                  <span>{{ message.status }}</span>
                </div>
                <div v-if="message.error" class="message-error">
                  <span>{{ message.error }}</span>
                  <button v-if="message.retryText" :disabled="streaming" @click="retry(message.retryText)">重新生成</button>
                </div>
                <span v-if="message.streaming" class="typing-caret" aria-label="正在生成" />
              </div>
            </article>
          </section>
          <p v-if="error && messages.length" class="assistant-inline-error">{{ error }}</p>
          <div ref="messageEndRef" class="message-end" />
        </template>
      </main>
    </ion-content>

    <ion-footer class="assistant-footer ion-no-border">
      <div class="composer-wrap">
        <textarea
          ref="inputRef"
          v-model="draft"
          rows="1"
          maxlength="12000"
          placeholder="发消息给开发助手…"
          :disabled="loading || !token"
          aria-label="输入消息"
          @input="resizeInput"
          @keydown.enter="onEnter"
        />
            <ion-button v-if="streaming" class="send-button stop-button" aria-label="停止生成" :disabled="!runId" @click="stopGeneration">
          <ion-icon :icon="stopOutline" />
        </ion-button>
        <ion-button v-else class="send-button" aria-label="发送消息" :disabled="!draft.trim() || loading" @click="send()">
          <ion-icon :icon="sendOutline" />
        </ion-button>
      </div>
      <p class="composer-note">AI 回复可能有误，请核对重要信息</p>
    </ion-footer>

    <ion-modal :is-open="historyOpen" class="history-modal" @didDismiss="historyOpen = false">
      <ion-header class="ion-no-border"><ion-toolbar><ion-title>最近对话</ion-title><ion-buttons slot="end"><ion-button @click="historyOpen = false">完成</ion-button></ion-buttons></ion-toolbar></ion-header>
      <ion-content>
        <ion-list v-if="threads.length" class="history-list">
          <ion-item v-for="thread in threads" :key="thread.id" button :detail="false" :class="{ selected: thread.id === activeThread?.id }" @click="selectThread(thread)">
            <ion-icon slot="start" :icon="chatbubbleEllipsesOutline" />
            <ion-label><strong>{{ thread.title || '新的对话' }}</strong><p>{{ formatDate(thread.updated_at) }}</p></ion-label>
          </ion-item>
        </ion-list>
        <div v-else class="history-empty">还没有历史对话</div>
      </ion-content>
    </ion-modal>
  </ion-page>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import {
  IonButton, IonButtons, IonContent, IonFooter, IonHeader, IonIcon, IonItem, IonLabel,
  IonList, IonModal, IonPage, IonSpinner, IonTitle, IonToolbar
} from '@ionic/vue'
import {
  addOutline, chatbubbleEllipsesOutline, chevronBackOutline, sendOutline,
  sparklesOutline, stopOutline, timeOutline
} from 'ionicons/icons'
import {
  bootstrapAssistant, cancelAssistantRun, createAssistantRun, createAssistantThread,
  getAssistantHistory, getMobileAssistantAgent, listAssistantThreads, streamAssistantRun
} from '@/api/assistant'
import type { AssistantAgent, AssistantMessage, AssistantThread } from '@/api/assistant'

interface ChatMessage extends AssistantMessage {
  streaming?: boolean
  status?: string
  error?: string
  retryText?: string
}

const suggestions = ['帮我分析一段 SQL', '解释这个报错', '写一个 Python 脚本']
const token = ref('')
const agent = ref<AssistantAgent | null>(null)
const threads = ref<AssistantThread[]>([])
const activeThread = ref<AssistantThread | null>(null)
const messages = ref<ChatMessage[]>([])
const draft = ref('')
const loading = ref(false)
const streaming = ref(false)
const historyOpen = ref(false)
const error = ref('')
const runId = ref('')
const inputRef = ref<HTMLTextAreaElement | null>(null)
const messageEndRef = ref<HTMLElement | null>(null)
const contentRef = ref<{ $el?: HTMLIonContentElement } | null>(null)
const keepFollowing = ref(true)
let streamController: AbortController | null = null
let messageIndex = 0

function nextId() { messageIndex += 1; return `mobile-assistant-${Date.now()}-${messageIndex}` }

async function initialize() {
  loading.value = true
  error.value = ''
  try {
    const session = await bootstrapAssistant()
    token.value = session.access_token
    agent.value = getMobileAssistantAgent()
    threads.value = await listAssistantThreads(token.value, agent.value.id)
    const previousId = localStorage.getItem('mobile-assistant-thread')
    const selected = threads.value.find((thread) => thread.id === previousId) || threads.value[0]
    if (selected) await selectThread(selected, false)
    else {
      activeThread.value = null
      messages.value = []
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '开发助手连接失败'
  } finally {
    loading.value = false
  }
}

async function refreshThreads() {
  if (!token.value || !agent.value) return
  threads.value = await listAssistantThreads(token.value, agent.value.id)
}

async function selectThread(thread: AssistantThread, closeHistory = true) {
  if (streaming.value || !token.value) return
  error.value = ''
  historyOpen.value = false
  activeThread.value = thread
  localStorage.setItem('mobile-assistant-thread', thread.id)
  try {
    const history = await getAssistantHistory(token.value, thread.id)
    messages.value = history.filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ ...message, id: message.id || nextId() }))
    await scrollToEnd()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '历史消息加载失败'
  }
  if (closeHistory) historyOpen.value = false
}

function newConversation() {
  if (streaming.value) return
  activeThread.value = null
  messages.value = []
  error.value = ''
  draft.value = ''
  localStorage.removeItem('mobile-assistant-thread')
  nextTick(() => inputRef.value?.focus())
}

function openHistory() {
  if (streaming.value) return
  historyOpen.value = true
  void refreshThreads().catch((cause) => { error.value = cause instanceof Error ? cause.message : '会话列表加载失败' })
}

function formatDate(value?: string) {
  if (!value) return '最近会话'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '最近会话' : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

async function scrollToEnd() {
  if (!keepFollowing.value) return
  await nextTick()
  messageEndRef.value?.scrollIntoView({ behavior: 'auto', block: 'end' })
}

async function trackScroll(event: CustomEvent<{ scrollTop: number }>) {
  const element = await (event.target as HTMLIonContentElement).getScrollElement()
  keepFollowing.value = element.scrollHeight - element.scrollTop - element.clientHeight < 140
}

function resizeInput() {
  const input = inputRef.value
  if (!input) return
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 128)}px`
}

function onEnter(event: KeyboardEvent) {
  if (event.isComposing || event.shiftKey) return
  event.preventDefault()
  void send()
}

function applyRunEvent(event: string, data: Record<string, unknown>, assistantMessage: ChatMessage) {
  const payload = (data.payload && typeof data.payload === 'object' ? data.payload : {}) as Record<string, unknown>
  const chunk = (payload.chunk && typeof payload.chunk === 'object' ? payload.chunk : {}) as Record<string, unknown>
  const streamEvent = (chunk.stream_event && typeof chunk.stream_event === 'object' ? chunk.stream_event : {}) as Record<string, unknown>

  if (event === 'messages' && streamEvent.type === 'message_delta' && typeof streamEvent.content === 'string') {
    assistantMessage.content += streamEvent.content
    assistantMessage.status = '正在回复'
    void scrollToEnd()
  } else if (event === 'messages' && streamEvent.type === 'tool_call') {
    assistantMessage.status = `正在使用${String(streamEvent.name || '工具')}…`
    void scrollToEnd()
  } else if (event === 'runtime_snapshot' || event === 'runtime_diagnostic') {
    assistantMessage.status = '正在准备回答…'
  } else if (event === 'human_approval_required') {
    assistantMessage.status = '等待审批，请在 Web 助手中处理此步骤'
    assistantMessage.streaming = false
    streamController?.abort()
  } else if (event === 'end') {
    assistantMessage.streaming = false
    const status = String(payload.status || 'completed')
    assistantMessage.status = status === 'failed' ? '本次回复未完成' : status === 'cancelled' ? '已停止' : ''
    if (status === 'failed') assistantMessage.error = '生成失败，可重新尝试。'
  } else if (event === 'error') {
    const detail = payload.error as Record<string, unknown> | undefined
    assistantMessage.streaming = false
    assistantMessage.status = '生成失败'
    assistantMessage.error = String(detail?.message || '连接中断，可重新尝试。')
  }
}

async function send(text = draft.value) {
  const query = text.trim()
  if (!query || !token.value || !agent.value || streaming.value) return
  draft.value = ''
  resizeInput()
  error.value = ''
  streaming.value = true
  keepFollowing.value = true
  messages.value.push({ id: nextId(), role: 'user', content: query })
  const reply: ChatMessage = { id: nextId(), role: 'assistant', content: '', streaming: true, status: '正在连接…', retryText: query }
  messages.value.push(reply)
  await scrollToEnd()

  try {
    if (!activeThread.value) {
      const thread = await createAssistantThread(token.value, agent.value.id, query.slice(0, 48) || '新的对话')
      activeThread.value = thread
      localStorage.setItem('mobile-assistant-thread', thread.id)
      threads.value = [thread, ...threads.value.filter((item) => item.id !== thread.id)]
    }
    const run = await createAssistantRun(token.value, activeThread.value.id, agent.value.slug, query)
    runId.value = run.run_id
    streamController = new AbortController()
    await streamAssistantRun(token.value, run.run_id, streamController.signal, (event, data) => applyRunEvent(event, data, reply))
    if (reply.streaming && !streamController.signal.aborted) {
      throw new Error('流式连接意外结束，可重新尝试。')
    }
    try {
      await refreshThreads()
    } catch {
      // 会话列表刷新失败不应把已经完成的回复误判为失败；打开历史时会再次刷新。
    }
  } catch (cause) {
    if (!streamController?.signal.aborted) {
      reply.streaming = false
      reply.status = '连接中断'
      reply.error = cause instanceof Error ? cause.message : '回复失败，可重新尝试。'
      void scrollToEnd()
    }
  } finally {
    streaming.value = false
    streamController = null
    runId.value = ''
  }
}

async function retry(query: string) {
  if (!activeThread.value) return
  messages.value = messages.value.filter((message) => !(message.role === 'assistant' && message.error))
  const lastUser = [...messages.value].reverse().find((message) => message.role === 'user')
  if (lastUser?.content === query) messages.value = messages.value.filter((message) => message !== lastUser)
  await send(query)
}

async function stopGeneration() {
  const targetRunId = runId.value
  if (!targetRunId || !token.value) return
  const controller = streamController
  const reply = [...messages.value].reverse().find((message) => message.role === 'assistant' && message.streaming)
  const cancellation = cancelAssistantRun(token.value, targetRunId)
  if (reply) {
    reply.streaming = false
    reply.status = '正在停止…'
  }
  controller?.abort()
  try {
    await cancellation
    if (reply) reply.status = '已停止'
  } catch (cause) {
    if (reply) {
      reply.status = '停止请求失败'
      reply.error = cause instanceof Error ? cause.message : '服务端停止请求失败，生成可能仍在继续。'
    }
  }
}

onMounted(initialize)
</script>

<style scoped>
.assistant-page { --background: var(--page-bg); }
.assistant-page ion-toolbar { --background: var(--panel); --border-color: var(--line); }
.assistant-page ion-title { overflow: hidden; font-size: 16px; text-overflow: ellipsis; white-space: nowrap; }
.assistant-head-button { min-width: 42px; min-height: 42px; --color: var(--mobile-text-accent); }
.assistant-content { --background: var(--page-bg); }
.assistant-body { min-height: 100%; display: flex; flex-direction: column; padding: 22px 16px 18px; }
.assistant-loading, .assistant-error-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--muted); text-align: center; }
.assistant-error-state > ion-icon { color: var(--mobile-text-accent); font-size: 36px; }
.assistant-error-state strong { color: var(--ion-text-color); font-size: 16px; }
.assistant-error-state span { max-width: 300px; font-size: 12px; line-height: 1.5; }
.assistant-welcome { margin: auto 0; padding: 8px 1px 30px; }
.assistant-mark { display: grid; place-items: center; width: 46px; height: 46px; margin-bottom: 24px; border: 1px solid var(--mobile-primary-line); border-radius: 15px; color: var(--mobile-text-accent); background: var(--mobile-primary-soft); font-size: 23px; }
.assistant-welcome .eyebrow { margin-bottom: 10px; font-size: 9px; }
.assistant-welcome h2 { max-width: 290px; margin: 0; color: var(--ion-text-color); font-size: 27px; line-height: 1.22; letter-spacing: -.045em; }
.welcome-copy { max-width: 300px; margin: 12px 0 24px; color: var(--muted); font-size: 13px; line-height: 1.55; }
.prompt-suggestions { display: grid; gap: 8px; }
.prompt-suggestions button { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 46px; padding: 0 13px; color: var(--ion-text-color); text-align: left; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); font: 500 12px var(--ion-font-family); }
.prompt-suggestions ion-icon { flex: 0 0 auto; transform: rotate(180deg); color: var(--mobile-text-accent); font-size: 15px; }
.assistant-messages { display: grid; gap: 22px; }
.chat-row { display: flex; align-items: flex-start; gap: 9px; }
.chat-row.user { justify-content: flex-end; }
.assistant-avatar { display: grid; place-items: center; flex: 0 0 27px; width: 27px; height: 27px; margin-top: 2px; border: 1px solid var(--mobile-primary-line); border-radius: 9px; color: var(--mobile-text-accent); background: var(--mobile-primary-soft); font-size: 14px; }
.chat-bubble { max-width: min(88%, 560px); min-width: 0; color: var(--ion-text-color); font-size: 14px; line-height: 1.65; }
.chat-row.assistant .chat-bubble { padding: 11px 13px; border: 1px solid var(--line); border-radius: 4px 15px 15px; background: var(--panel); box-shadow: 0 4px 18px rgba(20, 35, 51, .035); }
.chat-row.user .chat-bubble { padding: 10px 13px; border: 1px solid var(--mobile-primary-line); border-radius: 15px 4px 15px 15px; background: var(--mobile-primary-soft); }
.message-content { white-space: pre-wrap; overflow-wrap: anywhere; }
.message-status { display: flex; align-items: center; gap: 6px; margin-top: 5px; color: var(--muted); font-size: 10px; }
.message-status ion-spinner { width: 13px; height: 13px; }
.message-error { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 6px; color: var(--mobile-status-danger); font-size: 11px; }
.message-error button { padding: 3px 8px; color: var(--mobile-text-accent); border: 1px solid var(--mobile-primary-line); border-radius: 7px; background: var(--mobile-primary-soft); font: 650 10px var(--ion-font-family); }
.typing-caret { display: inline-block; width: 2px; height: 15px; margin-left: 2px; vertical-align: -2px; background: var(--blue); animation: caret-blink 1s steps(2, start) infinite; }
.assistant-inline-error { padding: 10px 12px; color: var(--mobile-status-danger); border: 1px solid var(--mobile-status-danger-line); border-radius: 10px; background: var(--mobile-status-danger-bg); font-size: 11px; }
.message-end { height: 1px; }
.assistant-footer { padding: 9px 12px max(7px, env(safe-area-inset-bottom)); border-top: 1px solid var(--line); background: var(--panel); }
.composer-wrap { display: flex; align-items: flex-end; gap: 7px; min-height: 48px; padding: 5px 5px 5px 13px; border: 1px solid var(--line); border-radius: 17px; background: var(--input-bg); }
.composer-wrap textarea { flex: 1; min-width: 0; max-height: 128px; resize: none; padding: 7px 0; color: var(--ion-text-color); border: 0; outline: none; background: transparent; font: 13px/1.45 var(--ion-font-family); }
.composer-wrap textarea::placeholder { color: var(--muted); }
.send-button { flex: 0 0 38px; width: 38px; height: 38px; margin: 0; --border-radius: 12px; --padding-start: 0; --padding-end: 0; --background: var(--blue); --color: #fff; }
.send-button ion-icon { font-size: 17px; }
.stop-button { --background: var(--panel); --color: var(--mobile-status-danger); --border-color: var(--mobile-status-danger-line); --border-style: solid; --border-width: 1px; }
.composer-note { margin: 5px 4px 0; color: var(--subtle); font-size: 9px; text-align: center; }
.history-modal { --height: 78%; --border-radius: 20px 20px 0 0; align-items: flex-end; }
.history-modal ion-toolbar { --background: var(--panel); --border-color: var(--line); }
.history-modal ion-content { --background: var(--panel); }
.history-list { background: var(--panel); }
.history-list ion-item { --background: var(--panel); --color: var(--ion-text-color); --border-color: var(--line); }
.history-list ion-item.selected { --background: var(--mobile-primary-soft); }
.history-list ion-item > ion-icon { color: var(--mobile-text-accent); }
.history-list ion-label strong { display: block; overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.history-list ion-label p { margin: 4px 0 0; color: var(--muted); font-size: 10px; }
.history-empty { padding: 45px 20px; color: var(--muted); text-align: center; font-size: 13px; }
@keyframes caret-blink { to { visibility: hidden; } }
@media (prefers-reduced-motion: reduce) { .typing-caret { animation: none; } }
</style>
