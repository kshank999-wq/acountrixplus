import { redirect } from 'next/navigation'
import { currentActor } from '@/lib/current-user'

export default async function Home() {
  const actor = await currentActor()
  redirect(actor ? '/bookkeeping' : '/login')
}
