import CustomerOrder from '../customer-order';

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <CustomerOrder qrToken={token} />;
}
