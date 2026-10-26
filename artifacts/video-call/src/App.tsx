import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster as ShadcnToaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Room from "@/pages/room";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/room/:roomId" component={Room} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        {/*
          The pages call `toast()` from "sonner", so sonner's <Toaster /> is the
          one that actually renders them. Mounting only the shadcn toaster here
          meant every error message ("Room not found", "Link copied") was
          invisible. Both are mounted; the shadcn one is kept for components
          that still use `useToast()`.
        */}
        <SonnerToaster position="top-center" richColors closeButton />
        <ShadcnToaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
