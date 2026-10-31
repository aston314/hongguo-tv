package rocks.aston.hongguotv;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativePreloadLeaseTest {
    @Test public void onlyTheExactSourceAndKeyCanBeClaimedOnce(){
        NativePreloadLease lease=new NativePreloadLease("owner","preload-1","next",1000);
        assertFalse(lease.claim("preload-2","next",0,0,2000));
        assertFalse(lease.claim("preload-1","another",0,0,2000));
        lease.completed(1500);assertEquals(500,lease.readyMs);
        assertTrue(lease.claim("preload-1","next",0,0,2000));
        assertFalse(lease.claim("preload-1","next",0,0,2000));
        assertFalse(lease.cancel("preload-1"));
    }
    @Test public void aResumeSeekOrAlternateCandidateUsesOrdinaryPlayback(){
        NativePreloadLease lease=new NativePreloadLease("owner","key","next",1000);
        assertFalse(lease.claim("key","next",10000,0,2000));
        assertFalse(lease.claim("key","next",0,1,2000));
        assertTrue(lease.claim("key","next",0,0,2000));
    }
    @Test public void expiredFailedAndCancelledPreparationsCannotBeUsed(){
        NativePreloadLease expired=new NativePreloadLease("owner","key","next",1000);
        assertFalse(expired.claim("key","next",0,0,NativePreloadLease.MAX_AGE_MS+1001));
        NativePreloadLease cancelled=new NativePreloadLease("owner","key","next",1000);
        assertFalse(cancelled.cancel("stale-key"));
        assertTrue(cancelled.cancel("key"));cancelled.completed(1500);
        assertEquals(-1,cancelled.readyMs);assertFalse(cancelled.claim("key","next",0,0,2000));
    }
}
