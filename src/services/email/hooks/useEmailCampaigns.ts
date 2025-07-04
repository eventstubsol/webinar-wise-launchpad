
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { EmailCampaign } from "@/types/email";

export function useEmailCampaigns(userId: string) {
  const queryClient = useQueryClient();

  const getCampaigns = async (): Promise<EmailCampaign[]> => {
    if (!userId) {
      throw new Error("User ID is required");
    }

    const { data, error } = await supabase
      .from("email_campaigns")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });
      
    if (error) {
      console.error("Error fetching email campaigns:", error);
      throw error;
    }
    
    return (data || []).map((row: any) => ({
      id: row.id,
      user_id: row.user_id,
      workflow_id: row.workflow_id,
      template_id: row.template_id,
      campaign_type: row.campaign_type,
      subject_template: row.subject_template,
      audience_segment: row.audience_segment,
      send_schedule: row.send_schedule,
      status: row.status,
      last_run_at: row.last_run_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  };

  const { data: campaigns, refetch, isLoading, error } = useQuery({
    queryKey: ["email_campaigns", userId],
    queryFn: getCampaigns,
    enabled: !!userId,
  });

  const mutation = useMutation({
    mutationFn: async (newCampaign: Partial<EmailCampaign>) => {
      if (!newCampaign.user_id) throw new Error("user_id required");
      if (!newCampaign.campaign_type) throw new Error("campaign_type required");
      if (!newCampaign.subject_template) throw new Error("subject_template required");
      if (!newCampaign.audience_segment) throw new Error("audience_segment required");
      if (!newCampaign.status) newCampaign.status = "draft";
      
      const insertObj = {
        user_id: newCampaign.user_id,
        workflow_id: newCampaign.workflow_id,
        template_id: newCampaign.template_id,
        campaign_type: newCampaign.campaign_type,
        subject_template: newCampaign.subject_template,
        audience_segment: newCampaign.audience_segment || {},
        send_schedule: newCampaign.send_schedule,
        status: newCampaign.status || "draft",
      };
      
      const { data, error } = await supabase
        .from("email_campaigns")
        .insert(insertObj)
        .select()
        .single();
        
      if (error) {
        console.error("Error creating email campaign:", error);
        throw error;
      }
      
      return data as EmailCampaign;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email_campaigns", userId] });
    },
    onError: (error) => {
      console.error("Campaign creation failed:", error);
    },
  });

  return {
    campaigns: campaigns || [],
    refetch,
    createCampaign: mutation.mutateAsync,
    isCampaignCreating: mutation.isPending,
    isLoading,
    error,
  };
}
