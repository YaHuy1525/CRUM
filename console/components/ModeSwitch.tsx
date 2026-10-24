'use client'

export type Mode = 'explore' | 'operate'

interface ModeSwitchProps {
  currentMode: Mode
  onModeChange: (mode: Mode) => void
}

export function ModeSwitch({ currentMode, onModeChange }: ModeSwitchProps) {
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Agent mode">
      <button
        role="radio"
        aria-checked={currentMode === 'explore'}
        className={`focus-ring ${currentMode === 'explore' ? 'active' : ''}`}
        onClick={() => onModeChange('explore')}
      >
        Explore
      </button>
      <button
        role="radio"
        aria-checked={currentMode === 'operate'}
        className={`focus-ring ${currentMode === 'operate' ? 'active' : ''}`}
        onClick={() => onModeChange('operate')}
      >
        Operate
      </button>
    </div>
  )
}
