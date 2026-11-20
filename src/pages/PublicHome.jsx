import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { createPageUrl } from "../utils";
import { Dumbbell, Utensils, CheckSquare, MessageCircle, ArrowRight } from "lucide-react";
import { BrandIcon, BrandWordmark } from "@/components/BrandMark";

// Member entry page. Sales and positioning live on brigadeathleticclub.com;
// this page's job is to get members into the app. Layout follows the Brand
// Bible: 1100px column, warm stone default, one gravity (near-black) moment.

const INSIDE = [
  { icon: Dumbbell, title: "Today's training", text: "Your program for the day, set by set, with what to aim for and room to log what you did." },
  { icon: Utensils, title: "Nutrition", text: "The plan your coach built for you, and a meal scanner for the days you eat out." },
  { icon: CheckSquare, title: "Habits and progress", text: "Daily habits, a streak that counts real days, and the numbers that show the work is landing." },
  { icon: MessageCircle, title: "Your coach", text: "Messages, sessions and check-ins in one thread. Nothing gets lost in a text chain." },
];

function Eyebrow({ children, className = "" }) {
  return (
    <p className={`text-xs font-bold uppercase tracking-[0.2em] text-primary ${className}`}>{children}</p>
  );
}

function Column({ children, className = "" }) {
  return <div className={`max-w-[1100px] mx-auto px-4 sm:px-6 ${className}`}>{children}</div>;
}

export default function PublicHome() {
  const navigate = useNavigate();
  const goToLogin = () => navigate(createPageUrl("Login"));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-50 bg-background/90 backdrop-blur border-b border-border">
        <Column className="h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <BrandIcon className="w-9 h-9" />
            <BrandWordmark className="text-lg">Brigade</BrandWordmark>
          </div>
          <button
            onClick={goToLogin}
            className="h-10 px-5 rounded-[6px] bg-primary text-primary-foreground text-sm font-bold uppercase tracking-[0.08em] hover:bg-primary/90 transition"
          >
            Sign in
          </button>
        </Column>
      </header>

      <main>
        {/* Opening */}
        <Column className="py-16 md:py-28">
          <Eyebrow>Brigade Athletic Club · Chattanooga</Eyebrow>
          <h1 className="mt-5 text-[48px] md:text-[72px] max-w-[900px]">
            The work doesn't stop at the door.
          </h1>
          <p className="mt-6 max-w-[620px] text-base leading-[1.7] text-muted-foreground">
            Your coach's plan, your habits, your progress, and a direct line to the people coaching you.
            All of it in one place, built for Brigade members.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-3">
            <button
              onClick={goToLogin}
              className="h-12 px-8 rounded-[6px] bg-primary text-primary-foreground text-sm font-bold uppercase tracking-[0.08em] hover:bg-primary/90 transition inline-flex items-center justify-center gap-2"
            >
              Sign in <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={goToLogin}
              className="h-12 px-8 rounded-[6px] border border-border text-foreground text-sm font-bold uppercase tracking-[0.08em] hover:bg-secondary transition"
            >
              Create your account
            </button>
          </div>
          <p className="mt-4 text-sm text-muted-foreground max-w-[520px]">
            New member? Your coach adds you first. Then create your account with the same email you gave us.
          </p>
        </Column>

        {/* What's inside */}
        <section className="border-t border-border">
          <Column className="py-16 md:py-24">
            <Eyebrow>What's inside</Eyebrow>
            <h2 className="mt-4 text-3xl md:text-5xl max-w-[760px]">Everything your coach sees, you see.</h2>
            <div className="mt-12 grid gap-px bg-border border border-border rounded-[6px] overflow-hidden sm:grid-cols-2">
              {INSIDE.map(({ icon: Icon, title, text }) => (
                <div key={title} className="bg-background p-6 md:p-8">
                  <Icon className="w-5 h-5 text-primary" />
                  <h3 className="mt-4 text-lg">{title}</h3>
                  <p className="mt-2 text-base leading-[1.7] text-muted-foreground">{text}</p>
                </div>
              ))}
            </div>
          </Column>
        </section>

        {/* The standard */}
        <section className="border-t border-border">
          <Column className="py-16 md:py-24 grid gap-8 md:grid-cols-[1fr_1.2fr] md:items-start">
            <div>
              <Eyebrow>The Standard</Eyebrow>
              <h2 className="mt-4 text-3xl md:text-5xl">Built around you, not a template.</h2>
            </div>
            <p className="text-base leading-[1.7] text-muted-foreground md:pt-10">
              Your program is written for your body, your history and your goals. When something hurts or
              life gets heavy, your coach adjusts the plan instead of asking you to push through it. That is
              what being coached means here.
            </p>
          </Column>
        </section>

        {/* Gravity moment: the closing ask */}
        <section style={{ background: "#191615", color: "#F9F7F6" }}>
          <Column className="py-20 md:py-[120px]">
            <Eyebrow>Not a member yet</Eyebrow>
            <h2 className="mt-5 text-[40px] md:text-[64px] max-w-[860px]">It's not too late. It just feels that way.</h2>
            <p className="mt-6 max-w-[600px] text-base leading-[1.7]" style={{ color: "#B4ADA7" }}>
              Most people here started while managing something. The first step is a conversation with a
              coach about where you are and what you want to change.
            </p>
            <a
              href="https://brigadeathleticclub.com"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-10 inline-flex h-12 px-8 items-center gap-2 rounded-[6px] bg-primary text-primary-foreground text-sm font-bold uppercase tracking-[0.08em] hover:bg-primary/90 transition"
            >
              Talk to a coach <ArrowRight className="w-4 h-4" />
            </a>
          </Column>
        </section>
      </main>

      <footer className="border-t border-border">
        <Column className="py-10 flex flex-col md:flex-row md:items-start md:justify-between gap-8 text-sm text-muted-foreground">
          <div>
            <div className="flex items-center gap-2">
              <BrandIcon className="w-7 h-7" />
              <BrandWordmark>Brigade</BrandWordmark>
            </div>
            <p className="mt-3">646 Overbridge Lane, Chattanooga, TN 37405</p>
          </div>
          <nav className="flex flex-wrap gap-x-6 gap-y-2">
            <Link to={createPageUrl("Contact")} className="hover:text-foreground transition">Contact</Link>
            <Link to={createPageUrl("PrivacyPolicy")} className="hover:text-foreground transition">Privacy</Link>
            <Link to={createPageUrl("Terms")} className="hover:text-foreground transition">Terms</Link>
            <Link to={createPageUrl("DataPolicy")} className="hover:text-foreground transition">Data Policy</Link>
          </nav>
        </Column>
        <Column className="pb-10 text-xs text-muted-foreground">
          © {new Date().getFullYear()} Brigade Athletic Club. Coaching, not medical advice.
        </Column>
      </footer>
    </div>
  );
}
