import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import Link from "next/link";
import { db, schema } from "@/lib/db";
import { eq, desc } from "drizzle-orm";
import { getCurrentUserId } from "@/lib/auth";
import { AddCaseButton } from "@/components/AddCaseDialog";
import { Briefcase, MessageSquare, Home } from "lucide-react";

async function loadSidebarData() {
  // Tolerate missing DATABASE_URL at build time so /_not-found can prerender.
  if (!process.env.DATABASE_URL) {
    return { cases: [], conversations: [] };
  }
  try {
    const userId = await getCurrentUserId();
    const cases = await db
      .select({
        id: schema.cases.id,
        name: schema.cases.name,
        applicationNumber: schema.cases.applicationNumber,
      })
      .from(schema.cases)
      .where(eq(schema.cases.userId, userId))
      .orderBy(desc(schema.cases.createdAt));

    const conversations = await db
      .select({
        id: schema.conversations.id,
        title: schema.conversations.title,
        caseId: schema.conversations.caseId,
      })
      .from(schema.conversations)
      .where(eq(schema.conversations.userId, userId))
      .orderBy(desc(schema.conversations.createdAt))
      .limit(20);

    return { cases, conversations };
  } catch {
    return { cases: [], conversations: [] };
  }
}

export async function AppSidebar() {
  const { cases, conversations } = await loadSidebarData();

  return (
    <Sidebar>
      <SidebarHeader className="border-b">
        <Link href="/" className="flex items-center gap-2 px-2 py-1">
          <Home className="size-4" />
          <span className="font-semibold">Prosecution Assistant</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <div className="flex items-center justify-between pr-2">
            <SidebarGroupLabel>My Cases</SidebarGroupLabel>
            <AddCaseButton />
          </div>
          <SidebarGroupContent>
            <SidebarMenu>
              {cases.length === 0 && (
                <p className="text-xs text-muted-foreground px-2 py-1">
                  No cases yet. Click + to add one.
                </p>
              )}
              {cases.map((c) => (
                <SidebarMenuItem key={c.id}>
                  <SidebarMenuButton render={<Link href={`/cases/${c.id}`} />}>
                    <Briefcase className="size-4" />
                    <span className="truncate">{c.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Recent conversations</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {conversations.length === 0 && (
                <p className="text-xs text-muted-foreground px-2 py-1">
                  No conversations yet.
                </p>
              )}
              {conversations.map((conv) => (
                <SidebarMenuItem key={conv.id}>
                  <SidebarMenuButton
                    size="sm"
                    render={
                      <Link href={conv.caseId ? `/cases/${conv.caseId}` : `/`} />
                    }
                  >
                    <MessageSquare className="size-3.5" />
                    <span className="truncate text-xs">{conv.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
