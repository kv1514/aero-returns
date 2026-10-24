import AeroApp from '@/components/aero-app';
export default async function Track({ params }: { params: Promise<{ id: string }> }) { return <AeroApp initialId={(await params).id} />; }
