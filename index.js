export default async function (ctx) {
  const { defineComponent, h, ref, defineAsyncComponent } = ctx.vue

  // ── 默认设置 ──
  const defaultSettings = {
    blurStep: 6,
    maxBlur: 24,
    currentScale: 1.3,
    normalScale: 0.85,
    minOpacity: 0.3,
    topOffset: 0,
    currentOffset: 0,
    bottomOffset: 0,
    curveIntensity: 4,
    curveEnabled: true,
    lineSpacing: 16,
    lyricAlign: 'center',
  }

  const Switch = defineAsyncComponent(ctx.ui.components.Switch)
  const settings = ref({ ...defaultSettings })

  ctx.storage.get('settings').then(s => {
    if (s) {
      Object.assign(settings.value, { ...defaultSettings, ...s })
      delete settings.value.enabled
    }
    injectSpacingStyles()
    updateAllRows()
  })

  const saveSettings = async (patch) => {
    Object.assign(settings.value, patch)
    await ctx.storage.set('settings', { ...settings.value })
    injectSpacingStyles()
    updateAllRows()
  }

  // ── 内部状态 ──
  let isUserScrolling = false
  let scrollCheckTimer = null
  let lastCurrentIndex = -2
  let lastLinesLength = -1
  let storeUnsub = null
  let rowObserveUnsub = null
  let removeSpacingStyles = null

  const lyricStore = ctx.stores.lyric

  // ── 注入过渡样式 ──
  const removeStyles = ctx.css.inject(`
    .lyric-line {
      transition: filter 0.35s ease, opacity 0.35s ease, transform 0.35s ease !important;
    }
  `, { id: 'lyric-focus-base' })

  // ── 注入歌词行过渡样式 ──
  const remove3DStyles = ctx.css.inject(`
    .lyric-row {
      transition: transform 0.35s ease !important;
      transform-origin: left center !important;
    }
  `, { id: 'lyric-focus-3d' })

  // ── 解除歌词行宽度 + 左边界限制（margin-left 左移裁切边界，translateX 可伸入封面区域） ──
  const removeWidthLimit = ctx.css.inject(`
    .lyric-line {
      max-width: none !important;
    }
    .lyric-scroller {
      box-sizing: content-box !important;
      width: 100% !important;
      margin-left: -200px !important;
      padding-left: 200px !important;
      padding-right: 0 !important;
    }
  `, { id: 'lyric-focus-width' })

  const injectSpacingStyles = () => {
    if (removeSpacingStyles) {
      removeSpacingStyles()
      removeSpacingStyles = null
    }

    const spacing = Number(settings.value.lineSpacing)
    const safeSpacing = Number.isFinite(spacing) ? spacing : defaultSettings.lineSpacing

    removeSpacingStyles = ctx.css.inject(`
      .lyric-row {
        padding-top: ${safeSpacing}px !important;
        padding-bottom: ${safeSpacing}px !important;
      }
    `, { id: 'lyric-focus-spacing' })
  }

  const getLyricAlignStyle = () => {
    const align = ['left', 'center', 'right'].includes(settings.value.lyricAlign)
      ? settings.value.lyricAlign
      : defaultSettings.lyricAlign

    if (align === 'left') {
      return { justifyContent: 'flex-start', textAlign: 'left', transformOrigin: 'left center' }
    }

    if (align === 'right') {
      return { justifyContent: 'flex-end', textAlign: 'right', transformOrigin: 'right center' }
    }

    return { justifyContent: 'center', textAlign: 'center', transformOrigin: 'center center' }
  }

  // ── 为单行应用模糊和弯曲 ──
  const applyBlurToRow = (rowEl) => {
    const lineEl = rowEl.querySelector('.lyric-line')
    if (!lineEl) return

    const index = parseInt(rowEl.getAttribute('data-lyric-index'), 10)
    if (isNaN(index)) return

    const currentIdx = lyricStore.currentIndex
    const s = settings.value

    // 歌词行间距通过 CSS 注入覆盖宿主行内样式，避免影响宿主滚动定位

    const alignStyle = getLyricAlignStyle()
    rowEl.style.justifyContent = alignStyle.justifyContent
    lineEl.style.textAlign = alignStyle.textAlign
    lineEl.style.transformOrigin = alignStyle.transformOrigin

    if (isUserScrolling || currentIdx < 0) {
      lineEl.style.filter = ''
      lineEl.style.opacity = ''
      lineEl.style.transform = ''
      rowEl.style.transform = ''
      return
    }

    const distance = index - currentIdx
    const absDistance = Math.abs(distance)
    const blurPx = Math.min(absDistance * s.blurStep, s.maxBlur)
    const opacity = Math.max(1 - absDistance * 0.15, s.minOpacity)
    const scale = index === currentIdx ? s.currentScale : s.normalScale

    lineEl.style.filter = `blur(${blurPx}px)`
    lineEl.style.opacity = String(opacity)
    lineEl.style.transform = `scale(${scale})`

    // 3 点偏移插值（顶部 / 当前行 / 底部）— 歌词行 X 起点位置
    const maxDist = 5
    const t = Math.min(Math.abs(distance) / maxDist, 1)
    let offset
    if (distance < 0) {
      offset = s.currentOffset + (s.topOffset - s.currentOffset) * t
    } else if (distance > 0) {
      offset = s.currentOffset + (s.bottomOffset - s.currentOffset) * t
    } else {
      offset = s.currentOffset
    }
    let transform = `translateX(${offset}px)`
    if (s.curveEnabled) {
      const curveAngle = distance * s.curveIntensity
      transform += ` rotate(${curveAngle}deg)`
    }
    rowEl.style.transform = transform
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
      row.style.transform = ''
      row.style.justifyContent = ''
      const lineEl = row.querySelector('.lyric-line')
      if (lineEl) {
        lineEl.style.filter = ''
        lineEl.style.opacity = ''
        lineEl.style.transform = ''
        lineEl.style.textAlign = ''
        lineEl.style.transformOrigin = ''
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
        settingRow(h, '顶部偏移', `${localSettings.value.topOffset}px`,
          h('input', {
            type: 'range', min: -200, max: 200, step: 1,
            value: localSettings.value.topOffset,
            onInput: (e) => handleChange('topOffset', Number(e.target.value)),
          })
        ),
        settingRow(h, '当前行偏移', `${localSettings.value.currentOffset}px`,
          h('input', {
            type: 'range', min: -200, max: 200, step: 1,
            value: localSettings.value.currentOffset,
            onInput: (e) => handleChange('currentOffset', Number(e.target.value)),
          })
        ),
        settingRow(h, '底部偏移', `${localSettings.value.bottomOffset}px`,
          h('input', {
            type: 'range', min: -200, max: 200, step: 1,
            value: localSettings.value.bottomOffset,
            onInput: (e) => handleChange('bottomOffset', Number(e.target.value)),
          })
        ),
        settingRow(h, '旋转强度', `${localSettings.value.curveIntensity.toFixed(1)}°`,
          h('input', {
            type: 'range', min: 5, max: 20, step: 0.01,
            value: localSettings.value.curveIntensity,
            onInput: (e) => handleChange('curveIntensity', parseFloat(e.target.value)),
          })
        ),
        settingRow(h, '旋转强度开关', localSettings.value.curveEnabled ? '开启' : '关闭',
          h(Switch, {
            modelValue: localSettings.value.curveEnabled,
            'onUpdate:modelValue': (v) => handleChange('curveEnabled', v),
          })
        ),
        settingRow(h, '歌词间距', `${localSettings.value.lineSpacing}px`,
          h('input', {
            type: 'range', min: 0, max: 60, step: 2,
            value: localSettings.value.lineSpacing,
            onInput: (e) => handleChange('lineSpacing', Number(e.target.value)),
          })
        ),
        settingRow(h, '歌词对齐', alignLabel(localSettings.value.lyricAlign),
          h('div', { class: 'lf-align-options' }, [
            alignOption(h, localSettings.value.lyricAlign, 'left', '左对齐', handleChange),
            alignOption(h, localSettings.value.lyricAlign, 'center', '居中', handleChange),
            alignOption(h, localSettings.value.lyricAlign, 'right', '右对齐', handleChange),
          ])
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
    title: '歌词美化设置',
    description: '自定义模糊强度与缩放比例',
    component: SettingsPanel,
  })

  // ── 清理 ──
  ctx.dispose(() => {
    clearAllRows()
    stopScrollCheck()
    if (storeUnsub) storeUnsub()
    if (rowObserveUnsub) rowObserveUnsub()
    if (removeSpacingStyles) removeSpacingStyles()
    removeStyles()
    remove3DStyles()
    removeWidthLimit()
  })

  ctx.toast.success('歌词美化已启用，打开歌词页查看效果')
}

// ── 辅助：设置面板行布局 ──
function settingRow(h, label, valueDisplay, inputNode) {
  return h('div', { class: 'lf-setting-row' }, [
    h('div', { class: 'lf-setting-label' }, [h('span', label)]),
    inputNode,
    h('span', { class: 'lf-setting-value' }, valueDisplay),
  ])
}

function alignLabel(value) {
  const labels = {
    left: '左',
    center: '中',
    right: '右',
  }

  return labels[value] || labels.center
}

function alignOption(h, currentValue, value, label, handleChange) {
  return h('button', {
    type: 'button',
    class: ['lf-align-option', currentValue === value ? 'is-active' : ''],
    onClick: () => handleChange('lyricAlign', value),
  }, label)
}
