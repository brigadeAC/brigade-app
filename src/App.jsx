import { lazy, Suspense } from 'react'
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import NavigationTracker from '@/lib/NavigationTracker'
import { pagesConfig } from './pages.config'
import { BrowserRouter as Router, Route, Routes, useLocation } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import Login from './pages/Login';
import PageBoundary from './lib/PageBoundary';

const BulkImport = lazy(() => import('./pages/BulkImport'));
const IndependentDashboard = lazy(() => import('./pages/IndependentDashboard'));
const ClientNotebooks = lazy(() => import('./pages/ClientNotebooks'));

const { Pages, Layout, mainPage } = pagesConfig;
const mainPageKey = mainPage ?? Object.keys(Pages)[0];
const MainPage = mainPageKey ? Pages[mainPageKey] : <></>;

const PageLoading = () => (
  <div className="flex justify-center py-24" role="status" aria-label="Loading">
    <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
  </div>
);

// Suspense sits inside the layout, so the menu stays put while a page loads.
const LayoutWrapper = ({ children, currentPageName }) => {
  const page = <PageBoundary key={currentPageName}><Suspense fallback={<PageLoading />}>{children}</Suspense></PageBoundary>;
  return Layout ? <Layout currentPageName={currentPageName}>{page}</Layout> : page;
};

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();
  const location = useLocation();

  // Public, standalone routes — rendered without the app Layout or auth gate.
  if (location.pathname === '/Login') {
    return <Login />;
  }

  // Show loading spinner while checking app public settings or auth
  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  // Handle authentication errors
  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      // Redirect to login automatically
      navigateToLogin();
      return null;
    }
  }

  // Render the main app
  return (
    <Routes>
      <Route path="/" element={
        <LayoutWrapper currentPageName={mainPageKey}>
          <MainPage />
        </LayoutWrapper>
      } />
      <Route path="/ClientAssistant" element={<PageNotFound />} />
      {Object.entries(Pages).map(([path, Page]) => (
        <Route
          key={path}
          path={`/${path}`}
          element={
            <LayoutWrapper currentPageName={path}>
              <Page />
            </LayoutWrapper>
          }
        />
      ))}
      <Route path="/BulkImport" element={
        <LayoutWrapper currentPageName="BulkImport">
          <BulkImport />
        </LayoutWrapper>
      } />
      <Route path="/ClientNotebooks" element={
        <LayoutWrapper currentPageName="ClientNotebooks">
          <ClientNotebooks />
        </LayoutWrapper>
      } />
      <Route path="/IndependentDashboard" element={
        <LayoutWrapper currentPageName="IndependentDashboard">
          <IndependentDashboard />
        </LayoutWrapper>
      } />
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};


function App() {

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <NavigationTracker />
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App