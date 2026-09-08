import * as React from "react"
import Image from "next/image"
import { Plus, MessageSquare, Trash2 } from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
} from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import type { ChatSession } from "@/lib/chat-history"

interface AppSidebarProps {
  onNewChat: () => void;
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
}

export function AppSidebar({ onNewChat, sessions, activeSessionId, onSelectSession, onDeleteSession }: AppSidebarProps) {
  return (
    <Sidebar className="bg-[#1e1e1e] border-r border-white/10 text-white">
      <SidebarHeader className="p-4 border-b border-white/10">
        <div className="flex items-center mb-4 px-2">
          <div className="relative h-8 w-28 flex items-center overflow-hidden">
            <Image src="/logo.png" alt="Chatit Logo" fill sizes="112px" className="object-contain object-left" />
          </div>
        </div>
        <button 
          onClick={onNewChat}
          className="flex items-center justify-center gap-2 w-full bg-[#819c70] text-black font-medium py-2 rounded-md hover:bg-[#6e8560] transition-colors shadow-sm"
        >
          <Plus className="h-4 w-4" />
          New Chat
        </button>
      </SidebarHeader>

      <SidebarContent className="no-scrollbar">
        <SidebarGroup>
          <SidebarGroupLabel className="text-gray-400 font-medium px-4 mt-2 mb-1">Recent Chats</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="px-2 gap-1">
              {sessions.length === 0 ? (
                <div className="text-xs text-gray-500 px-2 py-4 text-center">No recent chats</div>
              ) : (
                sessions.map((session) => (
                  <div
                    key={session.id}
                    onClick={() => onSelectSession(session.id)}
                    className={cn(
                      "group flex items-center gap-2 rounded-md px-2.5 py-2 cursor-pointer text-sm transition-colors",
                      session.id === activeSessionId
                        ? "bg-[#819c70]/20 text-white"
                        : "text-gray-300 hover:bg-white/5",
                    )}
                  >
                    <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
                    <span className="flex-1 truncate">{session.title}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(session.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 flex-shrink-0 text-gray-500 hover:text-red-400 transition-opacity"
                      aria-label="Delete chat"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
