export default async function (ctx) {
  const { defineComponent, h, ref } = ctx.vue

  // ── 默认设置 ──
  const defaultSettings = {
    blurStep: 6,
    maxBlur: 24,
    currentScale: 1.3,
    normalScale: 0.85,
    minOpacity: 0.3,
    enabled: true,
  }

  const settings = ref({ ...defaultSettings })

  ctx.storage.get('settings').then(s => {
    if (s) Object.assign(settings.value, { ...defaultSettings, ...s })
  })

  const saveSettings = async (patch) => {
    Object.assign(settings.value, patch)
    await ctx.storage.set('settings', { ...settings.value })
    updateAllRows()
  }

  // ── 内部状态 ──
  let isUserScrolling = false
  let scrollCheckTimer = null
  let lastCurrentIndex = -2
  let lastLinesLength = -1
  let storeUnsub = null
  let rowObserveUnsub = null

  const lyricStore = ctx.stores.lyric

  // ── 注入过渡样式 ──
  const removeStyles = ctx.css.inject(`
    .lyric-line {
      transition: filter 0.35s ease, opacity 0.35s ease, transform 0.35s ease !important;
    }
  `, { id: 'lyric-focus-base' })

  // ── 为单行应用模糊 ──
  const applyBlurToRow = (rowEl) => {
    if (!settings.value.enabled) return

    const lineEl = rowEl.querySelector('.lyric-line')
    if (!lineEl) return

    const index = parseInt(rowEl.getAttribute('data-lyric-index'), 10)
    if (isNaN(index)) return

    const currentIdx = lyricStore.currentIndex

    if (isUserScrolling || currentIdx < 0) {
      lineEl.style.filter = ''
      lineEl.style.opacity = ''
      lineEl.style.transform = ''
      return
    }

    const distance = Math.abs(index - currentIdx)
    const s = settings.value
    const blurPx = Math.min(distance * s.blurStep, s.maxBlur)
    const opacity = Math.max(1 - distance * 0.15, s.minOpacity)
    const scale = index === currentIdx ? s.currentScale : s.normalScale

    lineEl.style.filter = `blur(${blurPx}px)`
    lineEl.style.opacity = String(opacity)
    lineEl.style.transform = `scale(${scale})`
  }

  // ── 更新所有可见行 ──
  const updateAllRows = () => {
    const rows = ctx.dom.queryAll('.lyric-row')
    rows.forEach(row => applyBlurToRow(row))
  }

  // ── 清除所有行内联样式 ──
  const clearAllRows = () => {
    const rows = ctx.dom.queryAll('.lyric-row')
    rows.forEach(row => {
      const lineEl = row.querySelector('.lyric-line')
      if (lineEl) {
        lineEl.style.filter = ''
        lineEl.style.opacity = ''
        lineEl.style.transform = ''
      }
    })
  }

  // ── 轮询检测用户滚动状态 ──
  // 利用 useLyricScroll 添加的 .is-scroll-highlight 类名变化，
  // 完全避免与宿主滚动机制的时序冲突
  const startScrollCheck = () => {
    if (scrollCheckTimer) return
    scrollCheckTimer = setInterval(() => {
      const prev = isUserScrolling
      isUserScrolling = ctx.dom.query('.lyric-line.is-scroll-highlight') !== null
      if (isUserScrolling !== prev) {
        updateAllRows()
      }
    }, 200)
  }

  const stopScrollCheck = () => {
    if (scrollCheckTimer) {
      clearInterval(scrollCheckTimer)
      scrollCheckTimer = null
    }
  }

  // ── 监听 store 变化 ──
  lastCurrentIndex = lyricStore.currentIndex
  lastLinesLength = lyricStore.lines.length

  storeUnsub = lyricStore.$subscribe((mutation, state) => {
    if (isUserScrolling) {
      lastLinesLength = state.lines.length
      lastCurrentIndex = state.currentIndex
      return
    }

    const lenChanged = state.lines.length !== lastLinesLength
    const idxChanged = state.currentIndex !== lastCurrentIndex

    if (lenChanged) {
      lastLinesLength = state.lines.length
      lastCurrentIndex = state.currentIndex
      updateAllRows()
    } else if (idxChanged) {
      lastCurrentIndex = state.currentIndex
      updateAllRows()
    }
  })

  // ── 观察新出现的歌词行（虚拟滚动动态渲染） ──
  rowObserveUnsub = ctx.dom.observe('.lyric-row', (el) => {
    if (!isUserScrolling && lyricStore.currentIndex >= 0) {
      applyBlurToRow(el)
    }
    return () => {}
  })

  // ── 初始应用 ──
  updateAllRows()
  startScrollCheck()

  // ── 设置面板组件 ──
  const SettingsPanel = defineComponent({
    name: 'LyricFocusSettings',
    setup() {
      const localSettings = ref({ ...settings.value })

      const handleChange = (key, value) => {
        localSettings.value[key] = value
      }

      const handleSave = async () => {
        await saveSettings(localSettings.value)
        ctx.toast.success('设置已保存')
      }

      return () => h('div', { class: 'lf-settings' }, [
        h('div', { class: 'lf-setting-row' }, [
          h('div', { class: 'lf-setting-label' }, [h('span', '启用美化')]),
          h('input', {
            type: 'checkbox',
            checked: localSettings.value.enabled,
            onChange: (e) => handleChange('enabled', e.target.checked),
          }),
        ]),
        settingRow(h, '模糊步进', `${localSettings.value.blurStep}px`,
          h('input', {
            type: 'range', min: 1, max: 12, step: 1,
            value: localSettings.value.blurStep,
            onInput: (e) => handleChange('blurStep', Number(e.target.value)),
          })
        ),
        settingRow(h, '最大模糊', `${localSettings.value.maxBlur}px`,
          h('input', {
            type: 'range', min: 6, max: 48, step: 2,
            value: localSettings.value.maxBlur,
            onInput: (e) => handleChange('maxBlur', Number(e.target.value)),
          })
        ),
        settingRow(h, '当前行缩放', `${localSettings.value.currentScale.toFixed(1)}x`,
          h('input', {
            type: 'range', min: 100, max: 200, step: 5,
            value: localSettings.value.currentScale * 100,
            onInput: (e) => handleChange('currentScale', Number(e.target.value) / 100),
          })
        ),
        settingRow(h, '非当前行缩放', `${localSettings.value.normalScale.toFixed(2)}x`,
          h('input', {
            type: 'range', min: 50, max: 100, step: 5,
            value: localSettings.value.normalScale * 100,
            onInput: (e) => handleChange('normalScale', Number(e.target.value) / 100),
          })
        ),
        settingRow(h, '最低不透明度', `${Math.round(localSettings.value.minOpacity * 100)}%`,
          h('input', {
            type: 'range', min: 10, max: 80, step: 5,
            value: localSettings.value.minOpacity * 100,
            onInput: (e) => handleChange('minOpacity', Number(e.target.value) / 100),
          })
        ),
        h('button', {
          class: 'lf-save-btn',
          onClick: handleSave,
        }, '保存设置'),
      ])
    },
  })

  ctx.ui.settings.define({
    id: 'default',
    title: '歌词聚焦设置',
    description: '自定义模糊强度与缩放比例',
    component: SettingsPanel,
  })

  // ── 清理 ──
  ctx.dispose(() => {
    clearAllRows()
    stopScrollCheck()
    if (storeUnsub) storeUnsub()
    if (rowObserveUnsub) rowObserveUnsub()
    removeStyles()
  })

  ctx.toast.success('歌词聚焦已启用，打开歌词页查看效果')
}

// ── 辅助：设置面板行布局 ──
function settingRow(h, label, valueDisplay, inputNode) {
  return h('div', { class: 'lf-setting-row' }, [
    h('div', { class: 'lf-setting-label' }, [h('span', label)]),
    inputNode,
    h('span', { class: 'lf-setting-value' }, valueDisplay),
  ])
}
