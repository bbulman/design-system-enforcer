import { Button } from "@/components/ui/button"
export default function Page() {
  return (
    <main className="bg-paper p-6">
      <h1 className="text-ink text-[22px]">Hi</h1>
      <p className="text-red-600 md:p-[13px] hover:bg-[#7C3AED] gap-[0.75rem]">Oops</p>
      <div className="rounded-[12px] bg-zinc-100 border-gray-200/50 bg-black" />
      <Button>Go</Button>
    </main>
  )
}
