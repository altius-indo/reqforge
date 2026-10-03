import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppProvider } from "@/state/app"
import { ChatProvider } from "@/state/chat"
import App from "./App.tsx"
import "./index.css"

// follow the OS colour scheme (shadcn dark mode is class-based)
const dark = window.matchMedia("(prefers-color-scheme: dark)")
const applyScheme = () => document.documentElement.classList.toggle("dark", dark.matches)
applyScheme()
dark.addEventListener("change", applyScheme)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 15_000 },
  },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <AppProvider>
          <ChatProvider>
            <App />
            <Toaster position="bottom-center" richColors closeButton />
          </ChatProvider>
        </AppProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)
