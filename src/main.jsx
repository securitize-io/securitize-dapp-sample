import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'
import SamplePage from './pages/SamplePage'

// The app only has one route: /securitize-sample. Any other path redirects to it.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/securitize-sample" element={<SamplePage />} />
        <Route path="*" element={<Navigate to="/securitize-sample" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
