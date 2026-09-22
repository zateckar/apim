import React from 'react';

type P = { size?: number; className?: string; style?: React.CSSProperties; };

function S({ size = 16, children, className, style }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style}
    >
      {children}
    </svg>
  );
}

export const Dashboard = (p: P) => <S {...p}><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></S>;
export const Api = (p: P) => <S {...p}><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></S>;
// Apache Kafka logo — five filled nodes forming a "K": a vertical spine (top /
// centre / bottom) with two arms branching from the centre node to the right.
export const Kafka = (p: P) => <S {...p}><path d="M8 5.8V18.2M9.6 11.2L14.9 8.3M9.6 12.8L14.9 15.7"/><circle cx="8" cy="4" r="1.8" fill="currentColor" stroke="none"/><circle cx="8" cy="20" r="1.8" fill="currentColor" stroke="none"/><circle cx="8" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="16.5" cy="7.5" r="1.8" fill="currentColor" stroke="none"/><circle cx="16.5" cy="16.5" r="1.8" fill="currentColor" stroke="none"/></S>;
export const Users = (p: P) => <S {...p}><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2"/><path d="M15 20c0-2 2-3 4-3s4 1 4 3"/></S>;
export const Shield = (p: P) => <S {...p}><path d="M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/></S>;
export const Activity = (p: P) => <S {...p}><path d="M3 12h4l3-8 4 16 3-8h4"/></S>;
export const Server = (p: P) => <S {...p}><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><circle cx="7" cy="7" r="0.6"/><circle cx="7" cy="17" r="0.6"/></S>;
export const Apps = (p: P) => <S {...p}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></S>;
export const Book = (p: P) => <S {...p}><path d="M4 5v14a2 2 0 0 0 2 2h14V7a2 2 0 0 0-2-2H4z"/><path d="M4 5a2 2 0 0 1 2-2h12"/></S>;
export const ChevDown = (p: P) => <S {...p}><path d="M6 9l6 6 6-6"/></S>;
export const ChevRight = (p: P) => <S {...p}><path d="M9 6l6 6-6 6"/></S>;
export const ChevLeft = (p: P) => <S {...p}><path d="M15 6l-6 6 6 6"/></S>;
export const Check = (p: P) => <S {...p}><path d="M5 12l5 5 9-11"/></S>;
export const X = (p: P) => <S {...p}><path d="M6 6l12 12M18 6L6 18"/></S>;
export const Plus = (p: P) => <S {...p}><path d="M12 5v14M5 12h14"/></S>;
export const Search = (p: P) => <S {...p}><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></S>;
export const Bell = (p: P) => <S {...p}><path d="M6 9a6 6 0 0 1 12 0v5l2 2H4l2-2z"/><path d="M10 19a2 2 0 0 0 4 0"/></S>;
export const Sliders = (p: P) => <S {...p}><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="10" cy="7" r="2"/><circle cx="16" cy="17" r="2"/></S>;
export const Logout = (p: P) => <S {...p}><path d="M10 17l5-5-5-5"/><path d="M15 12H4"/><path d="M20 4v16"/></S>;
export const Refresh = (p: P) => <S {...p}><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></S>;
export const Edit = (p: P) => <S {...p}><path d="M4 20h4L20 8l-4-4L4 16v4z"/></S>;
export const Trash = (p: P) => <S {...p}><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M9 7V4h6v3"/></S>;
export const Copy = (p: P) => <S {...p}><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></S>;
export const Eye = (p: P) => <S {...p}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></S>;
export const EyeOff = (p: P) => <S {...p}><path d="M3 3l18 18"/><path d="M10.5 10.7a3 3 0 0 0 4.2 4.2"/><path d="M9.9 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9"/><path d="M6.2 6.2A16 16 0 0 0 2 12s4 7 10 7a10 10 0 0 0 4.1-.9"/></S>;
export const Settings = (p: P) => <S {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></S>;
export const Cert = (p: P) => <S {...p}><circle cx="12" cy="9" r="5"/><path d="M8.5 13L7 21l5-3 5 3-1.5-8"/></S>;
export const Key = (p: P) => <S {...p}><circle cx="8" cy="15" r="3"/><path d="M10 13l10-10 2 2-3 3 1 1-2 2-1-1-4 4"/></S>;
export const Upload = (p: P) => <S {...p}><path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M4 17v4h16v-4"/></S>;
export const Download = (p: P) => <S {...p}><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 17v4h16v-4"/></S>;
export const Info = (p: P) => <S {...p}><circle cx="12" cy="12" r="9"/><path d="M12 8v0M12 11v6"/></S>;
export const Alert = (p: P) => <S {...p}><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v0"/></S>;
export const Link = (p: P) => <S {...p}><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 1 0 7 7l1-1"/></S>;
export const Tag = (p: P) => <S {...p}><path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4h8l9.8 9.4z"/><circle cx="8" cy="8" r="1.5"/></S>;
export const Globe = (p: P) => <S {...p}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></S>;
export const Home = (p: P) => <S {...p}><path d="M3 12l9-8 9 8v9h-6v-6h-6v6H3z"/></S>;
export const Clock = (p: P) => <S {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></S>;
export const Play = (p: P) => <S {...p}><path d="M7 5v14l12-7z"/></S>;
export const Pause = (p: P) => <S {...p}><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></S>;
export const Save = (p: P) => <S {...p}><path d="M5 3h12l4 4v14H3V5a2 2 0 0 1 2-2z"/><path d="M7 3v6h8V3"/><rect x="7" y="13" width="10" height="6"/></S>;
export const MoreVertical = (p: P) => <S {...p}><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></S>;
export const Undo = (p: P) => <S {...p}><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 0 8h-2"/></S>;
export const Power = (p: P) => <S {...p}><path d="M12 2v10"/><path d="M5.6 7.4a8 8 0 1 0 12.8 0"/></S>;
// Wrench/tool glyph — FixMe's "Diagnose and repair" on Health Status.
export const Wrench = (p: P) => <S {...p}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></S>;

export const Mail = (p: P) => <S {...p}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></S>;

// Six sidebar entries used to share three glyphs (MCP and External systems both a link, A2A and
// Health Status both a pulse, Credentials and Global policy both a shield), so the icon told a
// reader scanning the sidebar nothing. Every entry has its own now; `routes.test.ts` keeps it so.
export const Bot = (p: P) => <S {...p}><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4"/><circle cx="12" cy="3.5" r="0.6"/><circle cx="9" cy="14" r="0.8"/><circle cx="15" cy="14" r="0.8"/></S>;
export const Plug = (p: P) => <S {...p}><path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/></S>;
export const Chart = (p: P) => <S {...p}><path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="10" width="3" height="7"/></S>;
export const Lock = (p: P) => <S {...p}><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></S>;
export const Sun = (p: P) => <S {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></S>;
export const Moon = (p: P) => <S {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></S>;
export const Menu = (p: P) => <S {...p}><path d="M4 6h16M4 12h16M4 18h16"/></S>;
