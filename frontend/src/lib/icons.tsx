import {
  Briefcase,
  Bug,
  Calendar,
  Code,
  FileText,
  GraduationCap,
  ListChecks,
  Mail,
  Megaphone,
  Pen,
  Search,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'

/** Icons a prompt skill can use. Keys match the backend's ICONS list. */
export const SKILL_ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  mail: Mail,
  'file-text': FileText,
  'list-checks': ListChecks,
  code: Code,
  'graduation-cap': GraduationCap,
  briefcase: Briefcase,
  megaphone: Megaphone,
  search: Search,
  pen: Pen,
  calendar: Calendar,
  bug: Bug,
}

export function SkillIcon({ name, className }: { name: string; className?: string }) {
  const Icon = SKILL_ICONS[name] ?? Sparkles
  return <Icon className={className} aria-hidden />
}
