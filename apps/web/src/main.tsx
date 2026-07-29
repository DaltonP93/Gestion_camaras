import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import App from './App'
import { StepUpModal } from './components/StepUpModal'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <StepUpModal />
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: '#21262d',
            color: '#f0f6fc',
            border: '1px solid #30363d',
            borderRadius: '8px',
            fontSize: '13px',
          },
          success: { iconTheme: { primary: '#3fb950', secondary: '#21262d' } },
          error: { iconTheme: { primary: '#f85149', secondary: '#21262d' } },
        }}
      />
    </BrowserRouter>
  </React.StrictMode>
)
