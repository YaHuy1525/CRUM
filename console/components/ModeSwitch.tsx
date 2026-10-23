'use client'

export type Mode = 'explore' | 'operate'

interface ModeSwitchProps {
  currentMode: Mode
  onModeChange: (mode: Mode) => void
}

export function ModeSwitch({ currentMode, onModeChange }: ModeSwitchProps) {
  return (
    <div className="mode-switch">
      <button
        className={currentMode === 'explore' ? 'active' : ''}
        onClick={() => onModeChange('explore')}
      >
        Explore
      </button>
      <button
        className={currentMode === 'operate' ? 'active' : ''}
        onClick={() => onModeChange('operate')}
      >
        Operate
      </button>
    </div>
  )
}
