<template>
  <div class="da">
    <!-- 左侧会话栏 -->
    <aside class="da-sidebar">
      <div class="da-brand">
        <span class="da-logo">DA</span>
        <span class="da-name">开发助手</span>
        <button class="da-new" title="新建会话" @click="onNewSession">
          <el-icon><Plus /></el-icon>
        </button>
      </div>
      <div class="da-proj">
        <button class="da-proj__cur" title="切换项目" @click="projOpen = !projOpen">
          <el-icon class="da-proj__icon"><FolderOpened /></el-icon>
          <span class="da-proj__name">{{ curProject ? curProject.name : '全部会话' }}</span>
          <el-icon class="da-proj__caret"><ArrowDown /></el-icon>
        </button>
        <div v-if="projOpen" class="da-proj__menu">
          <div class="da-proj__item" :class="{ 'da-proj__item--sel': !curProject }" @click="selectProject(null)">
            <el-icon><Folder /></el-icon> 全部会话
          </div>
          <div
            v-for="p in projects"
            :key="p.id"
            class="da-proj__item"
            :class="{ 'da-proj__item--sel': curProject?.id === p.id }"
            @click="selectProject(p)"
          >
            <el-icon><FolderOpened /></el-icon>
            <span class="da-proj__item-name">{{ p.name }}</span>
            <span class="da-proj__item-del" title="删除项目(保留文件)" @click.stop="onDeleteProject(p)">×</span>
          </div>
          <div class="da-proj__new">
            <input
              v-model="newProjName"
              class="da-proj__input"
              placeholder="新项目名称…"
              @keydown.enter="onCreateProject"
            />
            <button class="da-proj__add" title="创建项目" @click="onCreateProject">+</button>
          </div>
        </div>
      </div>
      <div class="da-actions">
        <button class="da-act" title="压缩当前会话" @click="doCompact"><el-icon><Minus /></el-icon></button>
        <button class="da-act" title="回退到检查点" @click="doRewind"><el-icon><RefreshLeft /></el-icon></button>
        <button class="da-act" title="分支" @click="openBranches"><el-icon><Share /></el-icon></button>
      </div>
      <div class="da-search">
        <el-icon class="da-search__icon"><Search /></el-icon>
        <input v-model="sessionQuery" class="da-search__input" type="search" placeholder="搜索会话…" />
      </div>
      <div class="da-sessions">
        <div
          v-for="s in visibleSessions"
          :key="s.id"
          class="da-session"
          :class="{ 'da-session--active': s.id === activeId }"
          @click="onSelect(s.id)"
        >
          <div class="da-session__main">
            <span class="da-session__title">{{ s.title }}</span>
            <span class="da-session__time">{{ relTime(s.updatedAt) }}</span>
          </div>
          <button class="da-session__del" title="删除会话" @click.stop="onDelete(s.id)">
            <el-icon><Delete /></el-icon>
          </button>
        </div>
        <div v-if="!visibleSessions.length" class="da-empty">
          {{ curProject ? '该项目下暂无会话' : '暂无会话,点击右上角 + 新建' }}
        </div>
      </div>
    </aside>

    <!-- 右侧聊天区 -->
    <section class="da-main">
      <!-- 欢迎页 -->
      <div v-if="!messages.length" class="da-welcome">
        <div class="da-welcome__logo">DA</div>
        <h2 class="da-welcome__title">开发助手</h2>
        <p class="da-welcome__tag">基于大模型的数据平台开发助手 · SQL / 运维 / 排障</p>
        <div class="da-welcome__ex">
          <button v-for="ex in examples" :key="ex" class="da-ex" @click="sendExample(ex)">{{ ex }}</button>
        </div>
        <div class="da-welcome__hints">
          <span><kbd>Enter</kbd> 发送</span>
          <span><kbd>Shift</kbd>+<kbd>Enter</kbd> 换行</span>
        </div>
      </div>

      <!-- 消息流 -->
      <div v-else ref="chatBox" class="da-chat" @click="onMainClick">
        <div
          v-for="m in messages"
          :key="m.id"
          class="da-msg"
          :class="m.role === 'user' ? 'da-msg--user' : 'da-msg--assistant'"
        >
          <div class="da-msg__bubble">
            <template v-if="m.role === 'assistant'">
              <div v-if="m.thinking" class="da-think" @click="toggleThink(m)">
                <span class="da-think__head">
                  <el-icon class="da-think__icon">
                    <CaretRight v-if="m.thinkCollapsed" /><CaretBottom v-else />
                  </el-icon>
                  思考过程
                </span>
                <div v-if="!m.thinkCollapsed" class="da-think__body">{{ m.thinking }}</div>
              </div>
              <div class="da-md" v-html="renderMd(m.content)"></div>
              <span v-if="generating && m.id === lastMsgId" class="da-cursor">▍</span>
            </template>
            <template v-else>{{ m.content }}</template>
          </div>
        </div>
        <!-- 工具审批卡片(agent 调用工具等待审批) -->
        <div v-for="ap in approvals" :key="ap.id" class="da-approval">
          <div class="da-approval__head">
            <el-icon class="da-approval__icon"><Warning /></el-icon>
            <span class="da-approval__title">工具审批</span>
          </div>
          <div class="da-approval__subject">
            <span class="da-approval__tool">{{ ap.tool }}</span>
            <span v-if="ap.subject" class="da-approval__desc">{{ ap.subject }}</span>
          </div>
          <div class="da-approval__actions">
            <button class="da-approval__btn da-approval__btn--allow" @click="resolveApproval(ap, { allow: true })">允许</button>
            <button class="da-approval__btn" @click="resolveApproval(ap, { allow: true, session: true })">本次会话</button>
            <button class="da-approval__btn da-approval__btn--deny" @click="resolveApproval(ap, { allow: false })">拒绝</button>
          </div>
        </div>
      </div>

      <!-- 底部输入区 -->
      <footer class="da-composer-wrap">
        <div v-if="slashOpen" class="da-slash">
          <div
            v-for="(c, i) in slashFiltered"
            :key="c.cmd"
            class="da-slash__item"
            :class="{ 'da-slash__item--sel': i === slashIndex }"
            @mousedown.prevent="acceptSlash(c)"
          >
            <span class="da-slash__sig">{{ c.sig }}</span>
            <span class="da-slash__desc">{{ c.desc }}</span>
          </div>
          <div v-if="!slashFiltered.length" class="da-slash__empty">无匹配命令</div>
        </div>
        <div class="da-composer" :class="{ 'da-composer--busy': generating }">
          <span class="da-composer__caret">›</span>
          <textarea
            v-model="draft"
            ref="inputEl"
            class="da-composer__input"
            :placeholder="generating ? '正在生成…' : '输入问题,Enter 发送,Shift+Enter 换行'"
            :disabled="generating"
            rows="1"
            @keydown="onKeydown"
          ></textarea>
          <button
            v-if="!generating"
            class="da-composer__btn da-composer__btn--send"
            :disabled="!draft.trim()"
            title="发送 (Enter)"
            @click="send()"
          >
            <el-icon><Position /></el-icon>
          </button>
          <button v-else class="da-composer__btn da-composer__btn--stop" title="停止生成" @click="stop()">
            <el-icon><VideoPause /></el-icon>
          </button>
        </div>
      </footer>
    </section>

    <!-- 分支面板 -->
    <el-dialog v-model="branchOpen" title="分支" width="540px" append-to-body>
      <div v-if="branchTree" class="da-tree">{{ branchTree }}</div>
      <div class="da-list">
        <div v-for="b in branches" :key="b.id" class="da-li" :class="{ 'da-li--active': b.current }">
          <div class="da-li__main">
            <div class="da-li__title">{{ b.title }}</div>
            <div class="da-li__meta">{{ b.turns ?? 0 }} turns{{ b.model ? ' · ' + b.model : '' }}</div>
            <div v-if="b.preview" class="da-li__prev">{{ b.preview }}</div>
          </div>
          <el-button size="small" :disabled="b.current || generating" @click="switchBranch(b.id)">
            {{ b.current ? '当前' : '切换' }}
          </el-button>
        </div>
        <div v-if="!branches.length" class="da-empty">暂无分支</div>
      </div>
    </el-dialog>

  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import {
  ArrowDown,
  CaretBottom,
  CaretRight,
  Delete,
  Folder,
  FolderOpened,
  Minus,
  Plus,
  Position,
  RefreshLeft,
  Search,
  Share,
  VideoPause,
  Warning
} from '@element-plus/icons-vue'
import {
  approveTool,
  bindSessionProject,
  connectAssistantEvents,
  createProject,
  createSession,
  deleteProject,
  deleteSession,
  getBranches,
  listMessages,
  listProjects,
  listSessions,
  runCommand,
  stopChat,
  submitChat,
  type AssistantProject,
  type AssistantSession,
  type BranchInfo,
  type ChatMessage
} from '@/api/assistant'

const examples = [
  '写一个 SQL:统计近 7 天各分区记录数',
  '帮我排查 Spark 任务卡住的问题',
  '分析这段执行计划有什么优化空间'
]

const sessions = ref<AssistantSession[]>([])
const activeId = ref('')
const messages = ref<ChatMessage[]>([])
const draft = ref('')
const sessionQuery = ref('')
const generating = ref(false)
const chatBox = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)

// 输入 / 时弹出命令菜单
watch(draft, (v) => {
  const t = v.trim()
  if (t.startsWith('/') && !t.includes(' ')) {
    slashOpen.value = true
    slashIndex.value = 0
  } else if (slashOpen.value && (t === '' || t.includes(' '))) {
    closeSlash()
  }
})

const filteredSessions = computed(() => {
  const q = sessionQuery.value.trim().toLowerCase()
  if (!q) return sessions.value
  return sessions.value.filter((s) => s.title.toLowerCase().includes(q))
})

// ── 项目制:项目分组 + 会话归属 + 工作目录注入 ──────────────
const projects = ref<AssistantProject[]>([])
const sessionProjects = ref<Record<string, string>>({})
const projOpen = ref(false)
const newProjName = ref('')
const curProjectId = ref<string | null>(null)

const curProject = computed(() => projects.value.find((p) => p.id === curProjectId.value) || null)
/** 当前项目下的会话(未选项目 = 全部) */
const visibleSessions = computed(() => {
  const list = filteredSessions.value
  if (!curProjectId.value) return list
  return list.filter((s) => sessionProjects.value[s.id] === curProjectId.value)
})

async function loadProjects() {
  const d = await listProjects().catch(() => ({ projects: [], sessionProjects: {} }))
  projects.value = d.projects
  sessionProjects.value = d.sessionProjects
  if (curProjectId.value && !projects.value.some((p) => p.id === curProjectId.value)) {
    curProjectId.value = null
  }
}

function selectProject(p: AssistantProject | null) {
  curProjectId.value = p?.id ?? null
  projOpen.value = false
}

async function onCreateProject() {
  const name = newProjName.value.trim()
  if (!name) return
  const p = await createProject(name)
  projects.value.push(p)
  newProjName.value = ''
  curProjectId.value = p.id
  projOpen.value = false
}

async function onDeleteProject(p: AssistantProject) {
  await deleteProject(p.id)
  projects.value = projects.value.filter((x) => x.id !== p.id)
  if (curProjectId.value === p.id) curProjectId.value = null
}

/** 会话归属当前项目 */
async function bindActiveSession() {
  if (!activeId.value) return
  const pid = curProjectId.value
  await bindSessionProject(activeId.value, pid)
  sessionProjects.value[activeId.value] = pid || ''
  // 归属变化后若当前项目过滤不包含该会话,自动清除选中
  if (pid && sessionProjects.value[activeId.value] !== pid) curProjectId.value = null
}

/** 发消息注入工作目录指令(让 agent 在项目目录下操作文件) */
function withWorkdir(text: string): string {
  if (!curProject.value) return text
  return `[项目: ${curProject.value.name} · 工作目录: /workspace/projects/${curProject.value.dir}/]
请在本项目工作目录下操作文件。
${text}`
}
const lastMsgId = computed(() => messages.value[messages.value.length - 1]?.id ?? '')

// ── 会话管理 ─────────────────────────────────────────────
async function loadSessions() {
  sessions.value = await listSessions()
  if (activeId.value && !sessions.value.some((s) => s.id === activeId.value)) {
    activeId.value = ''
    messages.value = []
  }
}

async function onNewSession() {
  const s = await createSession()
  sessions.value.unshift(s)
  await selectSession(s.id)
}

async function onSelect(id: string) {
  if (id !== activeId.value) await selectSession(id)
}

async function selectSession(id: string) {
  stop()
  activeId.value = id
  messages.value = await listMessages(id)
  await nextTick()
  scrollBottom(true)
}

async function onDelete(id: string) {
  await deleteSession(id)
  sessions.value = sessions.value.filter((s) => s.id !== id)
  if (id === activeId.value) {
    activeId.value = ''
    messages.value = []
    if (sessions.value.length) await selectSession(sessions.value[0].id)
  }
}

// ── 发送 / 停止 ──────────────────────────────────────────
function sendExample(text: string) {
  draft.value = text
  void send()
}

async function send() {
  const text = draft.value.trim()
  if (!text || generating.value) return
  draft.value = ''
  if (!activeId.value) {
    const s = await createSession()
    sessions.value.unshift(s)
    activeId.value = s.id
    // 新会话归属当前项目
    if (curProjectId.value) {
      await bindSessionProject(s.id, curProjectId.value)
      sessionProjects.value[s.id] = curProjectId.value
    }
  }
  const sid = activeId.value
  await bindActiveSession()
  const payload = withWorkdir(text)
  messages.value.push({ id: genId(), role: 'user', content: payload, createdAt: Date.now() })
  await nextTick()
  scrollBottom(true)
  // 提交后内容由全局 SSE 事件流推送(onTurnStart 建助手消息 / onText·onReasoning 增量 / onTurnDone 结束)
  try {
    await submitChat(sid, payload)
  } catch {
    generating.value = false
  }
}

function stop() {
  generating.value = false
  void stopChat()
}

// ── 侧栏操作:压缩/回退/分支/模型/统计 ────────────────────
const branchOpen = ref(false)
const branchTree = ref('')
const branches = ref<BranchInfo[]>([])

/** 命令执行后刷新当前会话消息 + 会话列表 */
async function refreshAfterCommand() {
  await new Promise((r) => setTimeout(r, 600))
  if (activeId.value) messages.value = await listMessages(activeId.value).catch(() => messages.value)
  void loadSessions()
}

async function doCompact() {
  if (generating.value) return
  await runCommand('/compact')
  await refreshAfterCommand()
}
async function doRewind() {
  if (generating.value) return
  await runCommand('/rewind')
  await refreshAfterCommand()
}

async function openBranches() {
  branchOpen.value = true
  try {
    const d = await getBranches()
    branchTree.value = d.tree || ''
    branches.value = d.branches
  } catch {
    /* 忽略 */
  }
}
async function switchBranch(id: string) {
  await runCommand(`/switch ${id}`)
  branchOpen.value = false
  await refreshAfterCommand()
}

// ── 斜杠命令菜单(输入 / 弹出,方向键选择,Enter 执行)──────
interface SlashCmd {
  cmd: string
  sig: string
  desc: string
  /** true = 需要参数(选择后填入输入框由用户补全) */
  needsArg?: boolean
}
const SLASH_CMDS: SlashCmd[] = [
  { cmd: 'new', sig: '/new', desc: '新会话' },
  { cmd: 'compact', sig: '/compact', desc: '压缩当前会话' },
  { cmd: 'rewind', sig: '/rewind', desc: '回退到检查点' },
  { cmd: 'tree', sig: '/tree', desc: '查看分支树' },
  { cmd: 'branch', sig: '/branch <名称>', desc: '创建分支', needsArg: true },
  { cmd: 'switch', sig: '/switch <id>', desc: '切换分支', needsArg: true },
  { cmd: 'model', sig: '/model <ref>', desc: '切换模型', needsArg: true },
  { cmd: 'effort', sig: '/effort <level>', desc: '推理强度', needsArg: true },
  { cmd: 'goal', sig: '/goal <任务>', desc: '设置目标', needsArg: true },
  { cmd: 'memory', sig: '/memory', desc: '查看记忆' },
  { cmd: 'mcp', sig: '/mcp', desc: 'MCP 工具状态' },
  { cmd: 'skill', sig: '/skill', desc: '技能列表' },
  { cmd: 'help', sig: '/help', desc: '帮助' }
]
const slashOpen = ref(false)
const slashIndex = ref(0)
const slashFiltered = computed(() => {
  const q = draft.value.trim()
  if (!q.startsWith('/')) return []
  const kw = q.slice(1).toLowerCase()
  if (!kw) return SLASH_CMDS
  return SLASH_CMDS.filter((c) => c.cmd.includes(kw) || c.sig.includes(kw))
})

function closeSlash() {
  slashOpen.value = false
  slashIndex.value = 0
}
/** 选择命令:无参直接执行;需参数则把 sig 填入输入框让用户补全 */
function acceptSlash(c: SlashCmd) {
  if (c.needsArg) {
    draft.value = c.sig.replace(/<[^>]*>/g, '').trim() + ' '
    inputEl.value?.focus()
  } else {
    draft.value = ''
    void runCommand('/' + c.cmd).then(() => refreshAfterCommand())
  }
  closeSlash()
}

// ── 输入区 ───────────────────────────────────────────────
function onKeydown(e: KeyboardEvent) {
  if (slashOpen.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      slashIndex.value = Math.min(slashIndex.value + 1, slashFiltered.value.length - 1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      slashIndex.value = Math.max(slashIndex.value - 1, 0)
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      if (slashFiltered.value[slashIndex.value]) acceptSlash(slashFiltered.value[slashIndex.value])
      return
    }
    if (e.key === 'Escape') {
      closeSlash()
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    void send()
  }
  // 输入框自动增高
  const el = inputEl.value
  if (el) {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 140) + 'px'
  }
}

// ── 工具 ─────────────────────────────────────────────────
function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function relTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function toggleThink(m: ChatMessage) {
  m.thinkCollapsed = !m.thinkCollapsed
}

function scrollBottom(force = false) {
  const el = chatBox.value
  if (!el) return
  // 用户上滑查看历史时不打扰;force(新消息/发送时)强制到底
  if (!force && el.scrollHeight - el.scrollTop - el.clientHeight > 120) return
  void nextTick(() => {
    if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight
  })
}

// ── markdown 轻量渲染(先转义 HTML 再解析结构,防 XSS)──────
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function inlineMd(s: string): string {
  let t = escapeHtml(s)
  // 行内代码(code 优先,避免 ** 等被解析)
  t = t.replace(/`([^`]+)`/g, '<code class="md-ic">$1</code>')
  // 链接
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  // 粗体 / 斜体
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  return t
}

function renderMd(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  let codeBuf: string[] = []
  let inCode = false
  let codeLang = ''

  const flushCode = () => {
    if (!codeBuf.length) return
    out.push(
      `<div class="md-codeblock"><div class="md-codeblock__head"><span>${escapeHtml(codeLang || 'code')}</span><button class="md-copy-btn" type="button">复制</button></div><pre><code>${codeBuf.join('\n')}</code></pre></div>`
    )
    codeBuf = []
  }

  for (; i < lines.length; i++) {
    const line = lines[i]
    const fence = line.match(/^```(\w*)/)
    if (fence) {
      if (inCode) {
        flushCode()
        inCode = false
        codeLang = ''
      } else {
        inCode = true
        codeLang = fence[1] || ''
      }
      continue
    }
    if (inCode) {
      codeBuf.push(escapeHtml(line))
      continue
    }
    const t = line.trim()
    if (!t) {
      out.push('<div class="md-p"></div>')
      continue
    }
    if (/^\|.*\|$/.test(t)) {
      // 表格(连续行收集)
      const rows: string[] = [t]
      while (i + 1 < lines.length && /^\|.*\|$/.test(lines[i + 1].trim())) {
        rows.push(lines[++i].trim())
      }
      const cells = (r: string) =>
        r
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => inlineMd(c.trim()))
      const isSep = (r: string) => /^[\s:|-]+$/.test(r.replace(/\|/g, ''))
      let html = '<table class="md-table">'
      rows.forEach((r, idx) => {
        if (idx === 1 && isSep(r)) return
        const tag = idx === 0 ? 'th' : 'td'
        html += `<tr>${cells(r).map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`
      })
      html += '</table>'
      out.push(html)
      continue
    }
    if (/^#{1,4}\s/.test(t)) {
      const level = t.match(/^(#{1,4})\s/)![1].length
      out.push(`<h${Math.min(level + 2, 4)} class="md-h">${inlineMd(t.replace(/^#{1,4}\s/, ''))}</h${Math.min(level + 2, 4)}>`)
      continue
    }
    if (/^>\s?/.test(t)) {
      out.push(`<blockquote class="md-quote">${inlineMd(t.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    if (/^[-*]\s/.test(t) || /^\d+\.\s/.test(t)) {
      const ordered = /^\d+\.\s/.test(t)
      const item = inlineMd(t.replace(/^[-*]\s/, '').replace(/^\d+\.\s/, ''))
      if (ordered) out.push(`<div class="md-li md-li--o">${item}</div>`)
      else out.push(`<div class="md-li">${item}</div>`)
      continue
    }
    out.push(`<div class="md-p">${inlineMd(t)}</div>`)
  }
  if (inCode) flushCode()
  return out.join('\n')
}

// 复制代码块(事件委托:点击 .md-copy-btn 复制同块 pre 内容)
function onCopyClick(e: MouseEvent) {
  const btn = (e.target as HTMLElement).closest('.md-copy-btn') as HTMLElement | null
  if (!btn) return
  const pre = btn.closest('.md-codeblock')?.querySelector('pre')
  if (!pre) return
  void navigator.clipboard.writeText(pre.textContent ?? '').then(() => {
    const old = btn.textContent
    btn.textContent = '已复制'
    setTimeout(() => (btn.textContent = old), 1200)
  })
}

// 主区点击委托:代码块复制按钮
function onMainClick(e: MouseEvent) {
  onCopyClick(e)
}

// ── 工具审批 ──────────────────────────────────────────────
const approvals = ref<{ id: string; tool: string; subject?: string }[]>([])

async function resolveApproval(ap: { id: string }, payload: { allow: boolean; session?: boolean }) {
  await approveTool(ap.id, payload)
  approvals.value = approvals.value.filter((x) => x.id !== ap.id)
}

// ── SSE 事件流(全局广播驱动当前会话渲染)──────────────────
let disconnectEvents: (() => void) | null = null

function handleTurnStart() {
  generating.value = true
  messages.value.push({ id: genId(), role: 'assistant', content: '', thinking: '', createdAt: Date.now() })
  scrollBottom(true)
}
function handleReasoning(delta: string) {
  const last = messages.value[messages.value.length - 1]
  if (last && last.role === 'assistant') {
    last.thinking = (last.thinking || '') + delta
    scrollBottom()
  }
}
function handleText(delta: string) {
  const last = messages.value[messages.value.length - 1]
  if (last && last.role === 'assistant') {
    last.content += delta
    scrollBottom()
  }
}
function handleTurnDone() {
  generating.value = false
  approvals.value = []
  // 标题/轮次由服务端生成,静默刷新列表(保留 activeId 选中态)
  void listSessions().then((list) => { sessions.value = list }).catch(() => {})
}
function handleApproval(ap: { id: string; tool: string; subject?: string }) {
  approvals.value.push(ap)
  scrollBottom(true)
}

// ── 生命周期 ─────────────────────────────────────────────
void loadSessions()
void loadProjects()
disconnectEvents = connectAssistantEvents({
  onTurnStart: handleTurnStart,
  onReasoning: handleReasoning,
  onText: handleText,
  onTurnDone: handleTurnDone,
  onApproval: handleApproval
})

onUnmounted(() => {
  disconnectEvents?.()
  disconnectEvents = null
})
</script>

<style scoped>
.da {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--bd-bg);
  color: var(--bd-text);
  font-size: 13px;
}

/* ── 左侧会话栏 ── */
.da-sidebar {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--bd-border);
  background: var(--bd-sidebar);
}
.da-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px 12px;
  border-bottom: 1px solid var(--bd-border);
}
.da-logo {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 12px;
  background: linear-gradient(135deg, var(--bd-primary), #7c5cff);
  color: #fff;
  font-family: var(--bd-font);
}
.da-name {
  flex: 1;
  font-weight: 600;
  font-size: 14px;
}
.da-new {
  width: 28px;
  height: 28px;
  border: 1px solid var(--bd-border);
  border-radius: 7px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--bd-text);
  cursor: pointer;
  transition: all 0.18s ease;
}
.da-new:hover {
  border-color: var(--bd-primary);
  color: var(--bd-primary);
}
.da-search {
  position: relative;
  padding: 10px 10px 6px;
}
.da-search__icon {
  position: absolute;
  left: 19px;
  top: 50%;
  transform: translateY(-40%);
  color: var(--bd-muted);
  font-size: 13px;
}
.da-search__input {
  width: 100%;
  height: 30px;
  padding: 0 10px 0 30px;
  border: 1px solid var(--bd-border);
  border-radius: 7px;
  background: var(--bd-panel);
  color: var(--bd-text);
  font-size: 12px;
  outline: none;
  transition: border-color 0.18s ease;
}
.da-search__input:focus {
  border-color: var(--bd-primary);
}
.da-sessions {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 8px 10px;
}
.da-session {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 7px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.da-session:hover {
  background: var(--bd-panel-sub);
}
.da-session--active {
  background: color-mix(in srgb, var(--bd-primary) 14%, transparent);
  color: var(--bd-primary);
}
.da-session__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.da-session__title {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.da-session__time {
  font-size: 11px;
  color: var(--bd-muted);
}
.da-session__del {
  display: none;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--bd-muted);
  cursor: pointer;
  align-items: center;
  justify-content: center;
}
.da-session:hover .da-session__del {
  display: flex;
}
.da-session__del:hover {
  color: #f56c6c;
  background: color-mix(in srgb, #f56c6c 12%, transparent);
}
.da-empty {
  padding: 20px 10px;
  text-align: center;
  color: var(--bd-muted);
  font-size: 12px;
}

/* ── 右侧聊天区 ── */
.da-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.da-welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 20px;
  text-align: center;
}
.da-welcome__logo {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  font-weight: 700;
  background: linear-gradient(135deg, var(--bd-primary), #7c5cff);
  color: #fff;
  font-family: var(--bd-font);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--bd-primary) 35%, transparent);
}
.da-welcome__title {
  margin: 8px 0 0;
  font-size: 22px;
  font-weight: 600;
}
.da-welcome__tag {
  color: var(--bd-muted);
  font-size: 13px;
}
.da-welcome__ex {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-top: 22px;
  max-width: 620px;
}
.da-ex {
  padding: 9px 14px;
  border: 1px solid var(--bd-border);
  border-radius: 9px;
  background: var(--bd-panel);
  color: var(--bd-text);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.18s ease;
}
.da-ex:hover {
  border-color: var(--bd-primary);
  color: var(--bd-primary);
  transform: translateY(-1px);
}
.da-welcome__hints {
  margin-top: 26px;
  display: flex;
  gap: 18px;
  color: var(--bd-muted);
  font-size: 11px;
}
.da-welcome__hints kbd {
  padding: 1px 6px;
  border: 1px solid var(--bd-border);
  border-radius: 4px;
  background: var(--bd-panel);
  font-family: var(--bd-font);
}

/* 消息流 */
.da-chat {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 22px 18px 10px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.da-msg {
  display: flex;
  max-width: 860px;
  width: 100%;
}
.da-msg--user {
  justify-content: flex-end;
  align-self: flex-end;
}
.da-msg--assistant {
  justify-content: flex-start;
  align-self: flex-start;
}
.da-msg__bubble {
  max-width: 100%;
  border-radius: 12px;
  padding: 10px 14px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.da-msg--user .da-msg__bubble {
  background: var(--bd-primary);
  color: #fff;
  border-bottom-right-radius: 4px;
}
.da-msg--assistant .da-msg__bubble {
  background: var(--bd-panel);
  border: 1px solid var(--bd-border);
  border-bottom-left-radius: 4px;
  color: var(--bd-text);
  white-space: normal;
}
.da-cursor {
  display: inline-block;
  color: var(--bd-primary);
  animation: da-blink 0.9s steps(1) infinite;
}
@keyframes da-blink {
  50% {
    opacity: 0;
  }
}

/* 工具审批卡片 */
.da-approval {
  align-self: flex-start;
  width: 100%;
  max-width: 860px;
  border: 1px solid color-mix(in srgb, #e6a23c 55%, var(--bd-border));
  border-radius: 10px;
  background: var(--bd-panel);
  padding: 10px 14px;
}
.da-approval__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.da-approval__icon {
  color: #e6a23c;
  font-size: 15px;
}
.da-approval__title {
  font-weight: 600;
  font-size: 13px;
}
.da-approval__subject {
  font-family: var(--bd-font);
  font-size: 12px;
  color: var(--bd-muted);
  background: var(--bd-panel-sub);
  border: 1px solid var(--bd-border);
  border-radius: 6px;
  padding: 7px 10px;
  margin-bottom: 10px;
  word-break: break-all;
  max-height: 90px;
  overflow-y: auto;
}
.da-approval__tool {
  color: var(--bd-text);
  font-weight: 600;
  margin-right: 6px;
}
.da-approval__actions {
  display: flex;
  gap: 6px;
}
.da-approval__btn {
  padding: 5px 14px;
  border: 1px solid var(--bd-border);
  border-radius: 6px;
  background: var(--bd-panel-sub);
  color: var(--bd-text);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.da-approval__btn--allow {
  background: color-mix(in srgb, var(--bd-primary) 16%, transparent);
  border-color: var(--bd-primary);
  color: var(--bd-primary);
}
.da-approval__btn--deny:hover {
  border-color: #f56c6c;
  color: #f56c6c;
}
.da-approval__btn:hover {
  border-color: var(--bd-primary);
}

/* 思考折叠块 */
.da-think {
  margin-bottom: 10px;
  border: 1px dashed var(--bd-border);
  border-radius: 8px;
  padding: 6px 10px;
  background: var(--bd-panel-sub);
}
.da-think__head {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--bd-muted);
  cursor: pointer;
  user-select: none;
}
.da-think__icon {
  font-size: 12px;
  transition: transform 0.15s ease;
}
.da-think__body {
  margin-top: 6px;
  font-size: 12px;
  color: var(--bd-muted);
  white-space: pre-wrap;
  border-top: 1px dashed var(--bd-border);
  padding-top: 6px;
}

/* markdown 渲染 */
.da-md {
  font-size: 13px;
}
.da-md :deep(.md-p) {
  margin: 4px 0;
}
.da-md :deep(.md-h) {
  margin: 10px 0 4px;
  font-size: 15px;
  font-weight: 600;
}
.da-md :deep(.md-quote) {
  margin: 6px 0;
  padding: 4px 10px;
  border-left: 3px solid var(--bd-primary);
  background: var(--bd-panel-sub);
  color: var(--bd-muted);
  border-radius: 0 6px 6px 0;
}
.da-md :deep(.md-li) {
  padding-left: 16px;
  position: relative;
}
.da-md :deep(.md-li)::before {
  content: '•';
  position: absolute;
  left: 4px;
  color: var(--bd-primary);
}
.da-md :deep(.md-li--o)::before {
  content: '›';
}
.da-md :deep(.md-ic) {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bd-panel-sub);
  border: 1px solid var(--bd-border);
  font-family: var(--bd-font);
  font-size: 12px;
}
.da-md :deep(.md-table) {
  border-collapse: collapse;
  margin: 8px 0;
  width: 100%;
  font-size: 12px;
}
.da-md :deep(.md-table th),
.da-md :deep(.md-table td) {
  border: 1px solid var(--bd-border);
  padding: 5px 10px;
  text-align: left;
}
.da-md :deep(.md-table th) {
  background: var(--bd-table-header);
  font-weight: 600;
}
.da-md :deep(a) {
  color: var(--bd-primary);
}
.da-md :deep(.md-codeblock) {
  margin: 8px 0;
  border: 1px solid var(--bd-border);
  border-radius: 8px;
  overflow: hidden;
  background: #0d1420;
}
.da-md :deep(.md-codeblock__head) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px;
  background: color-mix(in srgb, #0d1420 90%, var(--bd-primary) 8%);
  border-bottom: 1px solid var(--bd-border);
  font-size: 11px;
  color: var(--bd-muted);
  font-family: var(--bd-font);
}
.da-md :deep(.md-copy-btn) {
  border: 1px solid var(--bd-border);
  border-radius: 4px;
  background: transparent;
  color: var(--bd-muted);
  font-size: 11px;
  padding: 1px 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.da-md :deep(.md-copy-btn:hover) {
  color: var(--bd-primary);
  border-color: var(--bd-primary);
}
.da-md :deep(.md-codeblock pre) {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  font-family: var(--bd-font);
  font-size: 12px;
  line-height: 1.6;
  color: #d6e6f2;
}

/* ── 输入区 ── */
.da-composer-wrap {
  padding: 10px 18px 14px;
  position: relative;
}
.da-slash {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  width: min(520px, 92%);
  max-height: 300px;
  overflow-y: auto;
  margin-bottom: 6px;
  background: var(--bd-panel);
  border: 1px solid var(--bd-border);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25);
  padding: 4px;
  z-index: 20;
}
.da-slash__item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.da-slash__item--sel {
  background: color-mix(in srgb, var(--bd-primary) 14%, transparent);
  color: var(--bd-primary);
}
.da-slash__sig {
  font-family: var(--bd-font);
  font-weight: 600;
  flex-shrink: 0;
}
.da-slash__desc {
  color: var(--bd-muted);
  font-size: 11px;
}
.da-slash__empty {
  padding: 10px;
  text-align: center;
  color: var(--bd-muted);
  font-size: 12px;
}
.da-composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  max-width: 860px;
  margin: 0 auto;
  background: var(--bd-panel);
  border: 1px solid var(--bd-border);
  border-radius: 14px;
  padding: 8px 8px 8px 14px;
  box-shadow: 0 4px 16px color-mix(in srgb, var(--bd-border) 40%, transparent);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
.da-composer:focus-within {
  border-color: var(--bd-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--bd-primary) 18%, transparent);
}
.da-composer--busy {
  border-color: var(--bd-primary);
}
.da-composer__caret {
  color: var(--bd-primary);
  font-family: var(--bd-font);
  font-weight: 600;
  font-size: 16px;
  line-height: 1;
  padding-bottom: 8px;
}
.da-composer__input {
  flex: 1;
  border: none;
  background: none;
  color: var(--bd-text);
  font-size: 13px;
  line-height: 1.5;
  padding: 6px 0;
  outline: none;
  resize: none;
  min-height: 24px;
  max-height: 140px;
  font-family: inherit;
}
.da-composer__input::placeholder {
  color: var(--bd-muted);
}
.da-composer__btn {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.da-composer__btn--send {
  background: var(--bd-primary);
  color: #fff;
}
.da-composer__btn--send:hover:not(:disabled) {
  transform: scale(1.06);
}
.da-composer__btn--send:disabled {
  opacity: 0.4;
  cursor: default;
}
.da-composer__btn--stop {
  background: color-mix(in srgb, #f56c6c 15%, var(--bd-panel));
  color: #f56c6c;
}
.da-composer__btn--stop:hover {
  background: #f56c6c;
  color: #fff;
}

/* ── 项目选择器 ── */
.da-proj {
  position: relative;
  padding: 6px 10px 0;
}
.da-proj__cur {
  width: 100%;
  height: 32px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--bd-border);
  border-radius: 7px;
  background: var(--bd-panel);
  color: var(--bd-text);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.da-proj__cur:hover {
  border-color: var(--bd-primary);
}
.da-proj__icon {
  color: var(--bd-primary);
  font-size: 14px;
}
.da-proj__name {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.da-proj__caret {
  font-size: 12px;
  color: var(--bd-muted);
}
.da-proj__menu {
  position: absolute;
  top: calc(100% - 2px);
  left: 10px;
  right: 10px;
  z-index: 30;
  background: var(--bd-panel);
  border: 1px solid var(--bd-border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
  padding: 4px;
  max-height: 260px;
  overflow-y: auto;
}
.da-proj__item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.da-proj__item:hover {
  background: var(--bd-panel-sub);
}
.da-proj__item--sel {
  background: color-mix(in srgb, var(--bd-primary) 14%, transparent);
  color: var(--bd-primary);
}
.da-proj__item-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.da-proj__item-del {
  color: var(--bd-muted);
  font-size: 14px;
  padding: 0 2px;
}
.da-proj__item-del:hover {
  color: #f56c6c;
}
.da-proj__new {
  display: flex;
  gap: 4px;
  padding: 6px 4px 2px;
  border-top: 1px dashed var(--bd-border);
  margin-top: 2px;
}
.da-proj__input {
  flex: 1;
  min-width: 0;
  height: 26px;
  border: 1px solid var(--bd-border);
  border-radius: 5px;
  background: var(--bd-panel-sub);
  color: var(--bd-text);
  font-size: 12px;
  padding: 0 8px;
  outline: none;
}
.da-proj__input:focus {
  border-color: var(--bd-primary);
}
.da-proj__add {
  width: 26px;
  height: 26px;
  border: 1px solid var(--bd-border);
  border-radius: 5px;
  background: transparent;
  color: var(--bd-text);
  cursor: pointer;
}
.da-proj__add:hover {
  border-color: var(--bd-primary);
  color: var(--bd-primary);
}

/* ── 侧栏操作按钮行 ── */
.da-actions {
  display: flex;
  gap: 4px;
  padding: 4px 10px 2px;
}
.da-act {
  flex: 1;
  height: 30px;
  border: 1px solid var(--bd-border);
  border-radius: 7px;
  background: transparent;
  color: var(--bd-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}
.da-act:hover {
  border-color: var(--bd-primary);
  color: var(--bd-primary);
  background: color-mix(in srgb, var(--bd-primary) 8%, transparent);
}
.da-act .el-icon {
  font-size: 14px;
}

/* ── 面板(dialog 内容,teleport 到 body → :global) ── */
.da-tree {
  max-height: 140px;
  overflow: auto;
  margin-bottom: 10px;
  padding: 8px 10px;
  border: 1px dashed var(--bd-border);
  border-radius: 8px;
  background: var(--bd-panel-sub);
  font-family: var(--bd-font);
  font-size: 11px;
  color: var(--bd-muted);
  white-space: pre-wrap;
}
.da-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 420px;
  overflow-y: auto;
}
.da-li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--bd-border);
  border-radius: 8px;
  background: var(--bd-panel);
}
.da-li--active {
  border-color: var(--bd-primary);
  background: color-mix(in srgb, var(--bd-primary) 10%, var(--bd-panel));
}
.da-li__main {
  flex: 1;
  min-width: 0;
}
.da-li__title {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.da-li__meta {
  font-size: 11px;
  color: var(--bd-muted);
  margin-top: 2px;
}
.da-li__prev {
  font-size: 11px;
  color: var(--bd-muted);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
