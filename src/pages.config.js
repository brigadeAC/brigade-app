// Page routes. Each page loads on demand, so the first open stays small.
import { lazy } from 'react';
import Home from './pages/Home';
import __Layout from './Layout.jsx';

const About = lazy(() => import('./pages/About'));
const AskBrigade = lazy(() => import('./pages/AskBrigade'));
const AdminBugs = lazy(() => import('./pages/AdminBugs'));
const AdminContactMessages = lazy(() => import('./pages/AdminContactMessages'));
const BusinessHub = lazy(() => import('./pages/BusinessHub'));
const CRM = lazy(() => import('./pages/CRM'));
const ClientCommunity = lazy(() => import('./pages/ClientCommunity'));
const ClientDashboard = lazy(() => import('./pages/ClientDashboard'));
const ClientHabits = lazy(() => import('./pages/ClientHabits'));
const ClientJournal = lazy(() => import('./pages/ClientJournal'));
const ClientDocuments = lazy(() => import('./pages/ClientDocuments'));
const ClientMeals = lazy(() => import('./pages/ClientMeals'));
const ClientOnboarding = lazy(() => import('./pages/ClientOnboarding'));
const ClientProfile = lazy(() => import('./pages/ClientProfile'));
const ClientProgress = lazy(() => import('./pages/ClientProgress'));
const ClientRecovery = lazy(() => import('./pages/ClientRecovery'));
const ClientResources = lazy(() => import('./pages/ClientResources'));
const ClientSchedule = lazy(() => import('./pages/ClientSchedule'));
const ClientWorkouts = lazy(() => import('./pages/ClientWorkouts'));
const Clients = lazy(() => import('./pages/Clients'));
const Contact = lazy(() => import('./pages/Contact'));
const Contracts = lazy(() => import('./pages/Contracts'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const DataPolicy = lazy(() => import('./pages/DataPolicy'));
const FitnessTools = lazy(() => import('./pages/FitnessTools'));
const IndependentOnboarding = lazy(() => import('./pages/IndependentOnboarding'));
const Meals = lazy(() => import('./pages/Meals'));
const Messages = lazy(() => import('./pages/Messages'));
const OnboardingWalkthrough = lazy(() => import('./pages/OnboardingWalkthrough'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy'));
const Progress = lazy(() => import('./pages/Progress'));
const PublicHome = lazy(() => import('./pages/PublicHome'));
const Recipes = lazy(() => import('./pages/Recipes'));
const ReportBug = lazy(() => import('./pages/ReportBug'));
const Resources = lazy(() => import('./pages/Resources'));
const HabitLibrary = lazy(() => import('./pages/HabitLibrary'));
const LessonLibrary = lazy(() => import('./pages/LessonLibrary'));
const Programs = lazy(() => import('./pages/Programs'));
const Classes = lazy(() => import('./pages/Classes'));
const ClassSetup = lazy(() => import('./pages/ClassSetup'));
const ClassReports = lazy(() => import('./pages/ClassReports'));
const ClientClasses = lazy(() => import('./pages/ClientClasses'));
const MyLifts = lazy(() => import('./pages/MyLifts'));
const ProgramBuilder = lazy(() => import('./pages/ProgramBuilder'));
const ClientProgram = lazy(() => import('./pages/ClientProgram'));
const Schedule = lazy(() => import('./pages/Schedule'));
const Settings = lazy(() => import('./pages/Settings'));
const Team = lazy(() => import('./pages/Team'));
const Terms = lazy(() => import('./pages/Terms'));
const TrainerAssistant = lazy(() => import('./pages/TrainerAssistant'));
const TrainerCommunity = lazy(() => import('./pages/TrainerCommunity'));
const TrainerExpenses = lazy(() => import('./pages/TrainerExpenses'));
const TrainerJournalInsights = lazy(() => import('./pages/TrainerJournalInsights'));
const WaitingList = lazy(() => import('./pages/WaitingList'));
const Workouts = lazy(() => import('./pages/Workouts'));
const TodaysWorkout = lazy(() => import('./pages/TodaysWorkout'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const DailyWorkouts = lazy(() => import('./pages/DailyWorkouts'));
const MovementLibrary = lazy(() => import('./pages/MovementLibrary'));
const MemberBilling = lazy(() => import('./pages/MemberBilling')); // Phase 4: RULES


export const PAGES = {
    "About": About,
    "AskBrigade": AskBrigade,
    "AdminBugs": AdminBugs,
    "AdminContactMessages": AdminContactMessages,
    "BusinessHub": BusinessHub,
    "HabitLibrary": HabitLibrary,
    "LessonLibrary": LessonLibrary,
    "Programs": Programs,
    "Classes": Classes,
    "ClassSetup": ClassSetup,
    "ClassReports": ClassReports,
    "ClientClasses": ClientClasses,
    "MyLifts": MyLifts,
    "ProgramBuilder": ProgramBuilder,
    "ClientProgram": ClientProgram,
    "CRM": CRM,
    "ClientCommunity": ClientCommunity,
    "ClientDashboard": ClientDashboard,
    "ClientHabits": ClientHabits,
    "ClientJournal": ClientJournal,
    "ClientDocuments": ClientDocuments,
    "ClientMeals": ClientMeals,
    "ClientOnboarding": ClientOnboarding,
    "ClientProfile": ClientProfile,
    "ClientProgress": ClientProgress,
    "ClientRecovery": ClientRecovery,
    "ClientResources": ClientResources,
    "ClientSchedule": ClientSchedule,
    "ClientWorkouts": ClientWorkouts,
    "Clients": Clients,
    "Contact": Contact,
    "Contracts": Contracts,
    "Dashboard": Dashboard,
    "DataPolicy": DataPolicy,
    "FitnessTools": FitnessTools,
    "Home": Home,
    "IndependentOnboarding": IndependentOnboarding,
    "Meals": Meals,
    "Messages": Messages,
    "OnboardingWalkthrough": OnboardingWalkthrough,
    "PrivacyPolicy": PrivacyPolicy,
    "Progress": Progress,
    "PublicHome": PublicHome,
    "Recipes": Recipes,
    "ReportBug": ReportBug,
    "Resources": Resources,
    "Schedule": Schedule,
    "Settings": Settings,
    "Team": Team,
    "Terms": Terms,
    "TrainerAssistant": TrainerAssistant,
    "TrainerCommunity": TrainerCommunity,
    "TrainerExpenses": TrainerExpenses,
    "TrainerJournalInsights": TrainerJournalInsights,
    "WaitingList": WaitingList,
    "Workouts": Workouts,
    "TodaysWorkout": TodaysWorkout,
    "Leaderboard": Leaderboard,
    "DailyWorkouts": DailyWorkouts,
    "MovementLibrary": MovementLibrary,
    "MemberBilling": MemberBilling, // Phase 4: RULES
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};