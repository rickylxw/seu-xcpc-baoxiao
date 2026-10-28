<script setup>
import { computed, ref, watch } from 'vue'
import { state, previewFile } from '../store'
import { TYPE_META, allSlotsOf, slotsOf } from '../data/packaging'
import { isImageName } from '../utils/misc'
import { recognizeInto } from '../utils/pdfText'

const props = defineProps({
  leg: { type: Object, required: true },
  types: { type: Array, default: null }, // 该分组允许的交通类型（住宿为 null）
  removable: { type: Boolean, default: true },
  showMeta: { type: Boolean, default: true }, // 是否显示类型/说明
})
const emit = defineEmits(['remove'])

// ===== 收付款核对（发票开票方 vs 支付记录收款方，注意事项要求二者一致） =====
const leg = props.leg
if (!leg.payCheck) leg.payCheck = { issuer: '', payee: '', consistent: false, note: '' }
const invoiceSlotIds = computed(() => slotsOf(leg.type).filter((s) => /发票/.test(s.name)).map((s) => s.id))
const paySlotIds = computed(() => slotsOf(leg.type).filter((s) => /支付/.test(s.name)).map((s) => s.id))
const payCheckVisible = computed(
  () =>
    leg.files.some((f) => invoiceSlotIds.value.includes(f.slot)) &&
    leg.files.some((f) => paySlotIds.value.includes(f.slot)),
)
const metaIssuer = computed(() => {
  const f = leg.files.find((x) => invoiceSlotIds.value.includes(x.slot) && x.meta && x.meta.issuer)
  return (f && f.meta.issuer) || ''
})
const metaPayee = computed(() => {
  const f = leg.files.find((x) => paySlotIds.value.includes(x.slot) && x.meta && x.meta.payee)
  return (f && f.meta.payee) || ''
})
watch(
  [metaIssuer, metaPayee],
  ([iss, pay]) => {
    if (iss && !leg.payCheck.issuer) leg.payCheck.issuer = iss
    if (pay && !leg.payCheck.payee) leg.payCheck.payee = pay
  },
  { immediate: true },
)

const presetSlots = computed(() => (TYPE_META[props.leg.type] || TYPE_META.entryfee).slots)
const customSlots = computed(() => props.leg.customSlots || [])
const isTransport = computed(() => props.leg.group === 'transport')

const fileEl = ref(null)
let pendingSlot = null
let pendingSlotName = ''
let fid = 1
function browse(slotId) {
  pendingSlot = slotId
  const preset = presetSlots.value.find((s) => s.id === slotId)
  const custom = customSlots.value.find((s) => s.id === slotId)
  pendingSlotName = (preset && preset.name) || (custom && custom.name) || ''
  fileEl.value.click()
}
function onPick(e) {
  for (const f of e.target.files) {
    props.leg.files.push({
      id: `F${fid++}_${Date.now()}`,
      file: f,
      slot: pendingSlot,
      amount: '',
      members: null, // null = 全员
      scope: isTransport.value ? ['outbound', 'return'] : [],
      meta: null,
    })
    // 通过响应式数组取代理对象，保证异步识别结果能触发界面更新
    const obj = props.leg.files[props.leg.files.length - 1]
    recognizeInto(obj, state.members, state.serverOcr, pendingSlotName)
  }
  e.target.value = ''
}
const filesOf = (slotId) => props.leg.files.filter((f) => f.slot === slotId)
function removeFile(f) {
  const i = props.leg.files.indexOf(f)
  if (i >= 0) props.leg.files.splice(i, 1)
}

/* 识别结果汇总（PDF 文字提取 / 图片 OCR；进行中、失败、提示都展示） */
const recognitions = computed(() =>
  props.leg.files
    .filter((f) => f.meta)
    .map((f) => ({
      fileName: f.file.name,
      busy: !!f.meta.busy,
      via: f.meta.via || 'local',
      status: f.meta.status || '',
      progress: f.meta.progress || 0,
      amounts: f.meta.amounts || [],
      members: f.meta.members || [],
      error: f.meta.error || '',
      note: f.meta.note || '',
      serverError: f.meta.serverError || '',
    })),
)

/* 每个文件：归属队员 */
function memberOn(f, i) {
  return f.members == null || f.members.includes(i)
}
function toggleFileMember(f, i, ev) {
  const n = state.members.length
  const set = new Set(f.members == null ? state.members.map((_, k) => k) : f.members)
  if (ev.target.checked) set.add(i)
  else set.delete(i)
  f.members = set.size === n ? null : [...set].sort((a, b) => a - b)
}

/* 往返交通文件：去程 / 返程 勾选（至少保留一项） */
function scopeOn(f, s) {
  return (f.scope || []).includes(s)
}
function toggleScope(f, s, ev) {
  const set = new Set(f.scope || [])
  if (ev.target.checked) set.add(s)
  else {
    set.delete(s)
    if (!set.size) {
      ev.target.checked = true
      return
    }
  }
  f.scope = ['outbound', 'return'].filter((x) => set.has(x))
}

/* 自定义材料项：数量不限，名称可改 */
function addCustom() {
  if (!props.leg.customSlots) props.leg.customSlots = []
  props.leg.customSlots.push({ id: `CS${Date.now()}_${fid++}`, name: '' })
}
function removeCustom(cs) {
  const orphan = props.leg.files.filter((f) => f.slot === cs.id)
  if (orphan.length && !confirm(`「${cs.name || '其他材料'}」下已有 ${orphan.length} 个文件，确定删除该材料项及其文件？`)) return
  props.leg.files = props.leg.files.filter((f) => f.slot !== cs.id)
  const i = props.leg.customSlots.indexOf(cs)
  if (i >= 0) props.leg.customSlots.splice(i, 1)
}

function changeType(ev) {
  const t = ev.target.value
  if (t === props.leg.type) return
  if (props.leg.files.length && !confirm('切换交通类型将清空该段已上传的材料，确定？')) {
    ev.target.value = props.leg.type
    return
  }
  props.leg.type = t
  props.leg.files.splice(0)
}
</script>

<template>
  <div class="leg-card" :class="leg.group === 'transport' ? 'leg-transport' : 'leg-stay'">
    <div class="leg-head">
      <select v-if="showMeta" :value="leg.type" class="leg-type" @change="changeType">
        <option v-for="t in types" :key="t" :value="t">{{ TYPE_META[t].label }}</option>
      </select>
      <input
        v-if="showMeta"
        v-model="leg.label"
        class="leg-label"
        :placeholder="(TYPE_META[leg.type] && TYPE_META[leg.type].ph) || '段说明（选填，如：去程 / 往返 / 酒店）'"
      />
      <button v-if="removable" class="btn btn-sm btn-danger-ghost" @click="emit('remove')">删除本段</button>
    </div>

    <div class="slot-list">
      <!-- 预设材料项 -->
      <div v-for="s in presetSlots" :key="s.id" class="slot-block">
        <div class="slot-row head">
          <div class="slot-info">
            <div class="slot-name">
              {{ s.name }}
              <span :class="s.required ? 'req-chip' : 'mute-chip'">{{ s.required ? '必附' : '按需' }}</span>
            </div>
            <div v-if="s.note" class="slot-note">{{ s.note }}</div>
          </div>
          <div class="slot-files">
            <button type="button" class="btn btn-sm" @click="browse(s.id)">＋ 上传</button>
          </div>
        </div>

        <!-- 每个文件：金额 + 归属队员（往返交通文件另有去程/返程勾选） -->
        <div v-for="f in filesOf(s.id)" :key="f.id" class="file-row">
          <span
            class="file-name"
            :class="{ previewable: isImageName(f.file.name) }"
            :title="isImageName(f.file.name) ? `${f.file.name}（点击预览）` : f.file.name"
            @click="isImageName(f.file.name) && previewFile(f.file)"
          >{{ f.file.name }}</span>
          <div class="fr-tags">
            <template v-if="showMeta && isTransport">
              <label class="mem-chk sm scope" title="该文件适用于去程">
                <input type="checkbox" :checked="scopeOn(f, 'outbound')" @change="toggleScope(f, 'outbound', $event)" />去程
              </label>
              <label class="mem-chk sm scope" title="该文件适用于返程">
                <input type="checkbox" :checked="scopeOn(f, 'return')" @change="toggleScope(f, 'return', $event)" />返程
              </label>
            </template>
            <span
              v-if="f.meta && f.meta.header"
              class="pill"
              :class="f.meta.header.ok ? 'ok' : 'bad'"
              :title="f.meta.header.ok ? '发票抬头含「东南大学」' : '未识别到「东南大学」抬头，请人工核对该发票'"
            >
              抬头{{ f.meta.header.ok ? '✓' : '⚠' }}
            </span>
            <span
              v-if="f.meta && f.meta.cabin"
              class="pill"
              :class="f.meta.cabin.ok ? 'ok' : 'bad'"
              :title="f.meta.cabin.ok ? '含「经济舱」字样' : '未识别到「经济舱」字样，飞机仅限经济舱，请人工核对'"
            >
              {{ f.meta.cabin.ok ? '经济舱✓' : '未见经济舱⚠' }}
            </span>
            <span
              v-if="f.meta && f.meta.scopeAuto"
              class="pill ok"
              :title="`按 OCR 起讫地 ${f.meta.scopeAuto} 自动勾选，可手动修改去程 / 返程`"
            >
              自动:{{ f.meta.scopeAuto }}
            </span>
          </div>
          <input v-model="f.amount" class="file-amount" placeholder="金额" inputmode="decimal" />
          <div class="file-members">
            <label v-for="(m, i) in state.members" :key="i" class="mem-chk sm">
              <input type="checkbox" :checked="memberOn(f, i)" @change="toggleFileMember(f, i, $event)" />{{ m.name || '成员' + (i + 1) }}
            </label>
            <span v-if="!state.members.length" class="hint" style="margin: 0">先到「同学清单」录入同学</span>
          </div>
          <button type="button" class="file-del" title="移除" @click="removeFile(f)">×</button>
          <div v-if="f.meta && f.meta.busy" class="slot-note" style="width: 100%">正在识别（{{ f.file.name }}）…</div>
        </div>
      </div>

      <!-- 自定义材料项：数量不限，名称可改 -->
      <div v-for="cs in customSlots" :key="cs.id" class="slot-block">
        <div class="slot-row head">
          <div class="slot-info">
            <input v-model="cs.name" class="slot-name-input" placeholder="材料名称（默认：其他材料）" />
          </div>
          <div class="slot-files">
            <button type="button" class="btn btn-sm" @click="browse(cs.id)">＋ 上传</button>
            <button type="button" class="btn btn-sm btn-danger-ghost" @click="removeCustom(cs)">删除项</button>
          </div>
        </div>
        <div v-for="f in filesOf(cs.id)" :key="f.id" class="file-row">
          <span
            class="file-name"
            :class="{ previewable: isImageName(f.file.name) }"
            :title="isImageName(f.file.name) ? `${f.file.name}（点击预览）` : f.file.name"
            @click="isImageName(f.file.name) && previewFile(f.file)"
          >{{ f.file.name }}</span>
          <span
            v-if="f.meta && f.meta.header"
            class="pill"
            :class="f.meta.header.ok ? 'ok' : 'bad'"
            :title="f.meta.header.ok ? '发票抬头含「东南大学」' : '未识别到「东南大学」抬头，请人工核对该文件'"
          >
            抬头{{ f.meta.header.ok ? '✓' : '⚠' }}
          </span>
          <input v-model="f.amount" class="file-amount" placeholder="金额" inputmode="decimal" />
          <div class="file-members">
            <label v-for="(m, i) in state.members" :key="i" class="mem-chk sm">
              <input type="checkbox" :checked="memberOn(f, i)" @change="toggleFileMember(f, i, $event)" />{{ m.name || '成员' + (i + 1) }}
            </label>
          </div>
          <button type="button" class="file-del" title="移除" @click="removeFile(f)">×</button>
        </div>
      </div>

      <div>
        <button type="button" class="btn btn-sm" @click="addCustom">＋ 添加其他材料项</button>
      </div>

      <!-- PDF / 图片自动识别结果 -->
      <div v-if="recognitions.length" class="recog-block">
        <div class="recog-title">自动识别（金额与同学已自动填入上方对应文件，可修改）</div>
        <div v-for="r in recognitions" :key="r.fileName" class="recog-line">
          <span class="recog-file">{{ r.fileName }}</span>
          <span class="mute-chip">{{ r.via === 'server' ? '服务器' : '本地' }}</span>
          <template v-if="r.busy">
            <span class="slot-note">{{ r.status || '正在识别…' }}{{ r.progress ? ` ${Math.round(r.progress * 100)}%` : '' }}</span>
          </template>
          <template v-else-if="r.error">
            <span class="cov-miss">识别失败：{{ r.error }}</span>
          </template>
          <template v-else-if="r.note">
            <span class="slot-note">{{ r.note }}</span>
          </template>
          <template v-else>
            <span v-if="r.serverError" class="cov-miss">[服务器失败：{{ r.serverError }}]</span>
            <span>金额：<b>{{ r.amounts.join(' / ') || '未识别' }}</b></span>
            <span>同学：<b>{{ r.members.length ? r.members.map((m) => m.name).join('、') : '未识别' }}</b></span>
          </template>
        </div>
        <div v-if="payCheckVisible" class="paycheck">
          <div class="pc-title">
            收付款核对 <span class="pc-hint">发票「开票方 / 盖章单位」应与支付记录「收款方」一致（注意事项要求），识别后自动填入，请核对修改</span>
          </div>
          <div class="pc-grid">
            <label class="pc-field">
              <span>发票开票方</span>
              <input v-model="leg.payCheck.issuer" placeholder="从发票识别自动填入，可修改" />
            </label>
            <label class="pc-field">
              <span>支付记录收款方</span>
              <input v-model="leg.payCheck.payee" placeholder="从支付记录识别自动填入，可修改" />
            </label>
          </div>
          <label class="mem-chk">
            <input v-model="leg.payCheck.consistent" type="checkbox" />核对一致
          </label>
          <textarea
            v-if="!leg.payCheck.consistent"
            v-model="leg.payCheck.note"
            class="pc-note"
            rows="2"
            placeholder="不一致时填写情况说明（如通过平台代订，收款方为平台），打包时将生成「收付款方不一致说明.txt」一并提交"
          ></textarea>
        </div>
        <div class="slot-note">识别支持：文本型 PDF、图片（OCR）、OFD 发票、扫描件 PDF（部分浏览器不支持扫描件，请转图片后上传）。中文模型已内置，离线可用。</div>
      </div>
    </div>
    <input ref="fileEl" type="file" multiple hidden @change="onPick" />
  </div>
</template>
