import { Button } from "@/components/ui/button"
export default function Page() {
  return (
    <main>
      <h1 className="text-ink bg-paper">Title</h1>
      <h3>Skipped a level</h3>
      <img src="/hero.png" />
      <img src="/deco.png" alt="" />
      <button onClick={close}><svg viewBox="0 0 24 24"><path d="M0 0" /></svg></button>
      <button aria-label="Close"><XIcon /></button>
      <button><span className="sr-only">Close</span><XIcon /></button>
      <button>{label}</button>
      <a href="/settings"><GearIcon /></a>
      <input type="email" placeholder="Email" />
      <label>Name <input type="text" /></label>
      <label htmlFor="age">Age</label><input id="age" />
      <input type="hidden" name="t" />
      <div onClick={open}>Open</div>
      <div role="button" tabIndex={0} onClick={open} onKeyDown={key}>Fine</div>
      <span tabIndex={3}>x</span>
      <button aria-hidden="true">Hidden</button>
      <input autoFocus aria-label="Search" />
      <a onClick={go}>No href</a>
      <a href="#" onClick={go}>Hash</a>
      <p className="text-muted bg-paper">Low contrast?</p>
      <p className="text-gray-400 bg-white">Light grey on white</p>
      <p className="text-yellow-300 bg-white text-3xl">Big yellow</p>
      <p className="text-white bg-brand">White on brand</p>
      <p style={{ color: '#999999', background: '#ffffff' }}>inline</p>
      <p className="hover:text-gray-300 bg-white text-ink">hover state only</p>
    </main>
  )
}
