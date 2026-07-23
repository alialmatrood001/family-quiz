import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { connectFirebaseEmulators } from './firebase-emulators.js'

async function startApp() {
  await connectFirebaseEmulators()

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

startApp()
