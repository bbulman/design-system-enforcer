export function Button({ children }: { children: React.ReactNode }) {
  return <button className="bg-brand text-paper rounded-lg px-4 py-2 hover:bg-violet-700">{children}</button>
}
